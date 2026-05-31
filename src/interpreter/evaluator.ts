import {
  VMError,
  VMErrorCode,
  serializeAndReconstructBoundaryValue,
  serializeBoundaryValue,
  type VMSerializedValue as BoundarySerializedValue,
  type VMSerializableValue,
  type VMSerializedValue,
} from "../boundary";
import { parseProgram, type VMProgram } from "../parser";
import { VMEnvironment, createGlobalEnvironment, createLexicalEnvironment } from "./environment";
import {
  createArrayLikeObject,
  createOrdinaryObject,
  defineOwnProperty,
  deleteProperty as deleteObjectProperty,
  getOwnPropertyDescriptor,
  getPrototypeOf,
  isExtensible as isObjectExtensible,
  isArrayLikeObject,
  isVMObject,
  ownKeys,
  preventExtensions as preventObjectExtensions,
  set as setObjectProperty,
  setPrototypeOf as setObjectPrototype,
  type VMObject,
  type VMPropertyKey,
  type VMPropertyDescriptor,
  type VMPropertyDescriptorInput,
} from "./object-model";
import {
  VMExecutionContext,
  createExecutionContext,
  type ExecutionBudgetOptions,
  type VMCompletion,
  breakCompletion,
  continueCompletion,
  normalCompletion,
  returnCompletion,
  throwCompletion,
} from "./runtime";
import {
  createNativeCallable,
  constructNativeCallable,
  invokeHostCallable,
  invokeNativeCallable,
  isHostCallable,
  isNativeCallable,
  createVMSymbol,
  describeVMSymbol,
  isVMSymbol,
  type VMGuestCallable,
  type VMNativeCallableTools,
  type VMNativeCallable,
  type VMSymbol,
} from "./values";

export interface VMEvaluatorContextOptions {
  readonly globals?: Readonly<Record<string, unknown>>;
  readonly budget?: ExecutionBudgetOptions;
  readonly dateNow?: number;
}

export interface VMEvaluatorOptions {
  readonly context?: VMExecutionContext;
  readonly globals?: Readonly<Record<string, unknown>>;
  readonly budget?: ExecutionBudgetOptions;
}

type ASTNode = { readonly type: string; readonly [key: string]: unknown };

type VMInternalValue = unknown;
type Reference = BindingReference | MemberReference | PrivateMemberReference;

interface BindingReference {
  readonly kind: "binding";
  readonly name: string;
  get(): VMInternalValue | Promise<VMInternalValue>;
  set(value: VMInternalValue): VMInternalValue | Promise<VMInternalValue>;
  delete(): boolean | Promise<boolean>;
}

interface MemberReference {
  readonly kind: "member";
  readonly object: VMInternalValue;
  readonly key: VMPropertyKey;
  get(): Promise<VMInternalValue>;
  set(value: VMInternalValue): Promise<VMInternalValue>;
  delete(): boolean | Promise<boolean>;
}

interface PrivateMemberReference {
  readonly kind: "private-member";
  readonly object: VMObject;
  readonly key: string;
  get(): Promise<VMInternalValue>;
  set(value: VMInternalValue): Promise<VMInternalValue>;
  delete(): boolean | Promise<boolean>;
}

type VMUserFunction = VMObject;

interface VMUserFunctionRecord {
  readonly name?: string;
  readonly params: readonly ASTNode[];
  readonly body: ASTNode;
  readonly environment: VMEnvironment;
  readonly lexicalThis: unknown;
  readonly arrow: boolean;
  readonly constructable: boolean;
  readonly expressionBody: boolean;
  readonly async: boolean;
  readonly classInfo?: VMClassInfo;
  readonly homeObject?: VMObject;
  readonly privateEnvironment?: ReadonlyMap<string, VMPrivateName>;
}

interface VMPrivateName {
  readonly description: string;
}

type VMPrivateEntry =
  | { readonly kind: "field"; value: VMInternalValue }
  | { readonly kind: "method"; readonly value: VMUserFunction }
  | { readonly kind: "accessor"; readonly get?: VMUserFunction; readonly set?: VMUserFunction };

interface VMClassInfo {
  readonly name: string;
  readonly prototype: VMObject;
  readonly superClass?: VMUserFunction;
  readonly constructorMethod?: ASTNode;
  readonly environment: VMEnvironment;
  readonly privateEnvironment: ReadonlyMap<string, VMPrivateName>;
  readonly instanceElements: readonly VMClassInstanceElement[];
}

type VMClassInstanceElement =
  | { readonly kind: "field"; readonly key: VMPropertyKey; readonly value?: ASTNode }
  | {
      readonly kind: "private";
      readonly name: VMPrivateName;
      readonly entry:
        | VMPrivateEntry
        | { readonly kind: "field-initializer"; readonly value?: ASTNode };
    };

interface VMClassEvaluationOptions {
  readonly nameHint?: string;
  readonly initializeName?: (value: VMUserFunction) => void;
}

interface VMCallFrame {
  readonly record?: VMUserFunctionRecord;
  readonly homeObject?: VMObject;
  readonly privateEnvironment?: ReadonlyMap<string, VMPrivateName>;
  readonly construction?: VMDerivedConstructionState;
}

interface VMDerivedConstructionState {
  instance: VMObject;
  readonly classInfo: VMClassInfo;
  superInitialized: boolean;
  derivedElementsInitialized: boolean;
}

interface PatternBindingTarget {
  readonly environment: VMEnvironment;
  readonly kind: "var" | "let" | "const";
  readonly mutable?: boolean;
  readonly reuseExisting?: boolean;
}

interface ChainEvaluation {
  readonly value: VMInternalValue;
  readonly reference?: Reference;
  readonly shortCircuited: boolean;
}

interface VMNativeFunctionRecord {
  readonly call: NativeFunctionHandler;
  readonly construct?: NativeFunctionHandler;
}

type NativeFunctionHandler = (
  args: readonly VMInternalValue[],
  context: VMExecutionContext,
  thisValue: VMInternalValue | undefined,
) => VMInternalValue | Promise<VMInternalValue>;

interface VMIntrinsics {
  readonly objectPrototype: VMObject;
  readonly arrayPrototype: VMObject;
  readonly stringPrototype: VMObject;
  readonly numberPrototype: VMObject;
  readonly booleanPrototype: VMObject;
  readonly bigintPrototype: VMObject;
  readonly symbolPrototype: VMObject;
  readonly regexpPrototype: VMObject;
  readonly datePrototype: VMObject;
  readonly mapPrototype: VMObject;
  readonly setPrototype: VMObject;
  readonly arrayBufferPrototype: VMObject;
  readonly typedArrayPrototype: VMObject;
  readonly dataViewPrototype: VMObject;
  readonly errorPrototypes: Readonly<Record<VMErrorName, VMObject>>;
  readonly globals: Readonly<Record<string, VMInternalValue>>;
  readonly symbolRegistry: Map<string, VMSymbol>;
  readonly wellKnownSymbols: Readonly<Record<VMWellKnownSymbolName, VMSymbol>>;
  readonly dateNow?: number;
}

type VMErrorName =
  | "Error"
  | "TypeError"
  | "RangeError"
  | "ReferenceError"
  | "SyntaxError"
  | "URIError"
  | "EvalError";

type VMWellKnownSymbolName = "iterator" | "toPrimitive" | "toStringTag";

interface VMRegExpSlot {
  readonly regexp: RegExp;
}

interface VMDateSlot {
  time: number;
}

interface VMMapSlot {
  readonly entries: Array<{ key: VMInternalValue; value: VMInternalValue }>;
}

interface VMSetSlot {
  readonly values: VMInternalValue[];
}

interface VMTypedArraySlot {
  readonly type: string;
  readonly bytes: readonly number[];
}

interface VMProxySlot {
  readonly target: VMObject;
  readonly handler: VMObject;
}

const hasOwn = Object.prototype.hasOwnProperty;
const userFunctionRecords = new WeakMap<VMUserFunction, VMUserFunctionRecord>();
const dynamicEvalCallables = new WeakSet<VMNativeCallable>();
const contextFrames = new WeakMap<VMExecutionContext, VMCallFrame[]>();
const privateSlots = new WeakMap<VMObject, Map<VMPrivateName, VMPrivateEntry>>();
const uninitializedThis = Symbol("jsvm.uninitializedThis");
const nativeFunctionRecords = new WeakMap<VMObject, VMNativeFunctionRecord>();
const contextIntrinsics = new WeakMap<VMExecutionContext, VMIntrinsics>();
const globalObjectIntrinsics = new WeakMap<VMObject, VMIntrinsics>();
const regexpSlots = new WeakMap<VMObject, VMRegExpSlot>();
const dateSlots = new WeakMap<VMObject, VMDateSlot>();
const mapSlots = new WeakMap<VMObject, VMMapSlot>();
const setSlots = new WeakMap<VMObject, VMSetSlot>();
const arrayBufferSlots = new WeakMap<VMObject, ArrayBuffer>();
const typedArraySlots = new WeakMap<VMObject, VMTypedArraySlot>();
const dataViewSlots = new WeakMap<VMObject, readonly number[]>();
const proxySlots = new WeakMap<VMObject, VMProxySlot>();

class VMGuestException {
  readonly value: VMInternalValue;

  constructor(value: VMInternalValue) {
    this.value = value;
  }
}

export function createEvaluatorContext(
  options: VMEvaluatorContextOptions = {},
): VMExecutionContext {
  const globalEnvironment = createGlobalEnvironment();
  const intrinsics = createIntrinsics(options.dateNow);
  const globalObject = createOrdinaryObject(intrinsics.objectPrototype);

  defineGlobalBinding(globalEnvironment, globalObject, "globalThis", globalObject, {
    configurable: true,
    deletable: false,
    enumerable: false,
    mutable: false,
    writable: false,
  });

  if (!hasOwn.call(options.globals ?? {}, "undefined")) {
    defineGlobalBinding(globalEnvironment, globalObject, "undefined", undefined, {
      configurable: false,
      deletable: false,
      enumerable: false,
      mutable: false,
      writable: false,
    });
  }

  for (const [name, value] of Object.entries(intrinsics.globals)) {
    defineGlobalBinding(globalEnvironment, globalObject, name, value, {
      configurable: true,
      deletable: false,
      enumerable: false,
      mutable: true,
      writable: true,
    });
  }

  for (const [name, value] of Object.entries(options.globals ?? {})) {
    assertSafeBindingName(name);
    defineGlobalBinding(
      globalEnvironment,
      globalObject,
      name,
      importGuestValue(value, name, intrinsics),
      { configurable: true, deletable: true, enumerable: false, mutable: true, writable: true },
    );
  }

  const context = createExecutionContext({
    globalEnvironment,
    globalObject,
    lexicalEnvironment: globalEnvironment,
    variableEnvironment: globalEnvironment,
    budget: options.budget,
  });

  contextIntrinsics.set(context, intrinsics);
  globalObjectIntrinsics.set(globalObject, intrinsics);
  return context;
}

export function createDynamicCodeGlobals(): Readonly<Record<string, unknown>> {
  const dynamicEvaluator = createNativeCallable(
    "eval",
    (args, context) => evaluateDynamicSourceArgument(args[0], asExecutionContext(context), false),
    { arity: 1, description: "VM-owned dynamic source evaluator" },
  );
  dynamicEvalCallables.add(dynamicEvaluator);

  return Object.freeze({
    eval: dynamicEvaluator,
    Function: createDynamicCodeConstructor(false),
    AsyncFunction: createDynamicCodeConstructor(true),
  });
}

function createIntrinsics(dateNow?: number): VMIntrinsics {
  const objectPrototype = createOrdinaryObject(null);
  const arrayPrototype = createOrdinaryObject(objectPrototype);
  const stringPrototype = createOrdinaryObject(objectPrototype);
  const numberPrototype = createOrdinaryObject(objectPrototype);
  const booleanPrototype = createOrdinaryObject(objectPrototype);
  const bigintPrototype = createOrdinaryObject(objectPrototype);
  const symbolPrototype = createOrdinaryObject(objectPrototype);
  const regexpPrototype = createOrdinaryObject(objectPrototype);
  const datePrototype = createOrdinaryObject(objectPrototype);
  const mapPrototype = createOrdinaryObject(objectPrototype);
  const setPrototype = createOrdinaryObject(objectPrototype);
  const arrayBufferPrototype = createOrdinaryObject(objectPrototype);
  const typedArrayPrototype = createOrdinaryObject(objectPrototype);
  const dataViewPrototype = createOrdinaryObject(objectPrototype);
  const wellKnownSymbols = Object.freeze({
    iterator: createVMSymbol("Symbol.iterator", { wellKnownName: "Symbol.iterator" }),
    toPrimitive: createVMSymbol("Symbol.toPrimitive", { wellKnownName: "Symbol.toPrimitive" }),
    toStringTag: createVMSymbol("Symbol.toStringTag", { wellKnownName: "Symbol.toStringTag" }),
  } satisfies Record<VMWellKnownSymbolName, VMSymbol>);
  const errorPrototype = createOrdinaryObject(objectPrototype);
  const errorPrototypes = Object.freeze({
    Error: errorPrototype,
    EvalError: createOrdinaryObject(errorPrototype),
    RangeError: createOrdinaryObject(errorPrototype),
    ReferenceError: createOrdinaryObject(errorPrototype),
    SyntaxError: createOrdinaryObject(errorPrototype),
    TypeError: createOrdinaryObject(errorPrototype),
    URIError: createOrdinaryObject(errorPrototype),
  } satisfies Record<VMErrorName, VMObject>);
  const intrinsics = {
    arrayBufferPrototype,
    arrayPrototype,
    bigintPrototype,
    booleanPrototype,
    dataViewPrototype,
    dateNow,
    datePrototype,
    errorPrototypes,
    globals: Object.create(null) as Record<string, VMInternalValue>,
    mapPrototype,
    numberPrototype,
    objectPrototype,
    regexpPrototype,
    setPrototype,
    symbolPrototype,
    symbolRegistry: new Map<string, VMSymbol>(),
    stringPrototype,
    typedArrayPrototype,
    wellKnownSymbols,
  } satisfies VMIntrinsics;

  const ObjectConstructor = createNativeFunctionObject(
    "Object",
    (args, context) => {
      const value = args[0];
      if (value === null || value === undefined) {
        return createGuestObject(context);
      }
      return isVMObject(value) ? value : createPrimitiveWrapper(value, getIntrinsics(context));
    },
    { construct: (_args, context) => createGuestObject(context) },
  );
  const ArrayConstructor = createNativeFunctionObject(
    "Array",
    (args, context) => {
      if (args.length === 1 && typeof args[0] === "number") {
        const length = toArrayLength(args[0]);
        const array = createGuestArray([], context);
        defineArrayLengthValue(array, length);
        return array;
      }
      return createGuestArray(args, context);
    },
    { construct: (args, context) => ArrayConstructorRecord(args, context) },
  );
  const StringConstructor = createNativeFunctionObject(
    "String",
    async (args, context) => toStringExplicit(args[0], context),
    {
      construct: async (args, context) =>
        createPrimitiveWrapper(await toStringExplicit(args[0], context), getIntrinsics(context)),
    },
  );
  const NumberConstructor = createNativeFunctionObject(
    "Number",
    async (args, context) => toNumber(args[0] ?? 0, context),
    {
      construct: async (args, context) =>
        createPrimitiveWrapper(await toNumber(args[0] ?? 0, context), getIntrinsics(context)),
    },
  );
  const BigIntConstructor = createNativeFunctionObject("BigInt", async (args, context) =>
    toBigIntConstructorValue(args[0] ?? 0, context),
  );
  const BooleanConstructor = createNativeFunctionObject("Boolean", (args) => Boolean(args[0]), {
    construct: (args, context) => createPrimitiveWrapper(Boolean(args[0]), getIntrinsics(context)),
  });
  const SymbolConstructor = createNativeFunctionObject("Symbol", async (args, context) => {
    return createVMSymbol(
      args[0] === undefined ? undefined : await toStringForCoercion(args[0], context),
    );
  });
  const RegExpConstructor = createNativeFunctionObject(
    "RegExp",
    (args, context) => createRegExpFromArgs(args, getIntrinsics(context)),
    { construct: (args, context) => createRegExpFromArgs(args, getIntrinsics(context)) },
  );
  const DateConstructor = createNativeFunctionObject(
    "Date",
    (args, context) => {
      const date = createDateFromArgs(args, getIntrinsics(context));
      return new Date(assertDateSlot(date).time).toString();
    },
    { construct: (args, context) => createDateFromArgs(args, getIntrinsics(context)) },
  );
  const MapConstructor = createNativeFunctionObject(
    "Map",
    (_args, context) => createMapObject([], getIntrinsics(context)),
    {
      construct: async (args, context) =>
        createMapObject(
          await iterableEntries(args[0], asExecutionContext(context)),
          getIntrinsics(context),
        ),
    },
  );
  const SetConstructor = createNativeFunctionObject(
    "Set",
    (_args, context) => createSetObject([], getIntrinsics(context)),
    {
      construct: async (args, context) =>
        createSetObject(
          await iterableValues(args[0], asExecutionContext(context)),
          getIntrinsics(context),
        ),
    },
  );
  const ReflectObject = createOrdinaryObject(objectPrototype);
  const ProxyConstructor = createNativeFunctionObject(
    "Proxy",
    () => {
      throw runtimeError("Proxy must be called with new.", { reason: "invalid proxy call" });
    },
    {
      construct: (args, context) =>
        createProxyObject(args[0], args[1], asExecutionContext(context)),
    },
  );

  linkConstructor(ObjectConstructor, objectPrototype, "Object");
  linkConstructor(ArrayConstructor, arrayPrototype, "Array");
  linkConstructor(StringConstructor, stringPrototype, "String");
  linkConstructor(NumberConstructor, numberPrototype, "Number");
  linkConstructor(BigIntConstructor, bigintPrototype, "BigInt");
  linkConstructor(BooleanConstructor, booleanPrototype, "Boolean");
  linkConstructor(RegExpConstructor, regexpPrototype, "RegExp");
  linkConstructor(DateConstructor, datePrototype, "Date");
  linkConstructor(MapConstructor, mapPrototype, "Map");
  linkConstructor(SetConstructor, setPrototype, "Set");
  defineBuiltinData(SymbolConstructor, "prototype", symbolPrototype, {
    configurable: false,
    enumerable: false,
    writable: false,
  });
  defineBuiltinData(symbolPrototype, "constructor", SymbolConstructor, {
    configurable: true,
    enumerable: false,
    writable: true,
  });
  defineBuiltinData(symbolPrototype, wellKnownSymbols.toStringTag, "Symbol", {
    configurable: true,
    enumerable: false,
    writable: false,
  });

  defineBuiltin(
    objectPrototype,
    "valueOf",
    createNativeFunctionObject("Object.prototype.valueOf", (_args, context, thisValue) =>
      toObject(thisValue, context),
    ),
  );
  defineBuiltin(
    objectPrototype,
    "toString",
    createNativeFunctionObject("Object.prototype.toString", async (_args, context, thisValue) =>
      objectToString(thisValue, context),
    ),
  );

  defineBuiltinData(NumberConstructor, "POSITIVE_INFINITY", Number.POSITIVE_INFINITY, {
    configurable: false,
    enumerable: false,
    writable: false,
  });
  defineBuiltinData(NumberConstructor, "NEGATIVE_INFINITY", Number.NEGATIVE_INFINITY, {
    configurable: false,
    enumerable: false,
    writable: false,
  });
  defineBuiltinData(NumberConstructor, "MAX_VALUE", Number.MAX_VALUE, {
    configurable: false,
    enumerable: false,
    writable: false,
  });
  defineBuiltinData(NumberConstructor, "MIN_VALUE", Number.MIN_VALUE, {
    configurable: false,
    enumerable: false,
    writable: false,
  });
  defineBuiltinData(NumberConstructor, "NaN", Number.NaN, {
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const errorConstructors = createErrorConstructors(intrinsics);

  defineBuiltin(
    ObjectConstructor,
    "keys",
    createNativeFunctionObject("Object.keys", async (args, context) =>
      createGuestArray(
        await getEnumerableOwnStringKeys(toObject(args[0], context), context),
        context,
      ),
    ),
  );
  defineBuiltin(
    ObjectConstructor,
    "values",
    createNativeFunctionObject("Object.values", async (args, context) =>
      createGuestArray(
        await (
          await getEnumerableOwnStringKeys(toObject(args[0], context), context)
        ).reduce<Promise<VMInternalValue[]>>(async (promise, key) => {
          const values = await promise;
          values.push(await getGuestProperty(toObject(args[0], context), key, context));
          return values;
        }, Promise.resolve([])),
        context,
      ),
    ),
  );
  defineBuiltin(
    ObjectConstructor,
    "entries",
    createNativeFunctionObject("Object.entries", async (args, context) => {
      const object = toObject(args[0], context);
      const entries: VMInternalValue[] = [];
      for (const key of await getEnumerableOwnStringKeys(object, context)) {
        entries.push(
          createGuestArray([key, await getGuestProperty(object, key, context)], context),
        );
      }
      return createGuestArray(entries, context);
    }),
  );
  defineBuiltin(
    ObjectConstructor,
    "assign",
    createNativeFunctionObject("Object.assign", async (args, context) => {
      const target = toObject(args[0], context);
      for (const sourceValue of args.slice(1)) {
        if (sourceValue === null || sourceValue === undefined) {
          continue;
        }
        const source = toObject(sourceValue, context);
        for (const key of await getEnumerableOwnStringKeys(source, context)) {
          await setGuestProperty(
            target,
            key,
            await getGuestProperty(source, key, context),
            context,
          );
        }
      }
      return target;
    }),
  );
  defineBuiltin(
    ObjectConstructor,
    "create",
    createNativeFunctionObject("Object.create", (args, context) => {
      const prototype = args[0];
      if (prototype !== null && !isVMObject(prototype)) {
        throwGuestError(
          context,
          "TypeError",
          "Object.create prototype must be a VM object or null.",
        );
      }
      return createOrdinaryObject(prototype);
    }),
  );
  defineBuiltin(
    ObjectConstructor,
    "defineProperty",
    createNativeFunctionObject("Object.defineProperty", async (args, context) => {
      const object = toObject(args[0], context);
      const key = await toPropertyKey(args[1], context);
      const descriptor = await descriptorFromGuestObject(args[2], context);
      if (!(await definePropertyGuest(object, key, descriptor, context))) {
        throwGuestError(context, "TypeError", "Unable to define VM object property.");
      }
      return object;
    }),
  );
  defineBuiltin(
    ObjectConstructor,
    "getOwnPropertyDescriptor",
    createNativeFunctionObject("Object.getOwnPropertyDescriptor", async (args, context) => {
      const key = await toPropertyKey(args[1], context);
      const descriptor =
        getOwnCallablePropertyDescriptor(args[0], key) ??
        (await getOwnPropertyDescriptorGuest(toObject(args[0], context), key, context));
      return descriptor === undefined
        ? undefined
        : createGuestDescriptorObject(descriptor, context);
    }),
  );
  defineBuiltin(
    ObjectConstructor,
    "getPrototypeOf",
    createNativeFunctionObject("Object.getPrototypeOf", async (args, context) =>
      getPrototypeOfGuest(toObject(args[0], context), context),
    ),
  );
  defineBuiltin(
    ObjectConstructor,
    "setPrototypeOf",
    createNativeFunctionObject("Object.setPrototypeOf", async (args, context) => {
      const object = toObject(args[0], context);
      const prototype = args[1];
      if (prototype !== null && !isVMObject(prototype)) {
        throwGuestError(
          context,
          "TypeError",
          "Object.setPrototypeOf prototype must be a VM object or null.",
        );
      }
      if (!(await setPrototypeOfGuest(object, prototype, context))) {
        throw runtimeError("Unable to set VM object prototype.", {
          reason: "prototype set failed",
        });
      }
      return object;
    }),
  );
  defineBuiltin(
    ObjectConstructor,
    "isExtensible",
    createNativeFunctionObject("Object.isExtensible", async (args, context) =>
      isExtensibleGuest(toObject(args[0], context), context),
    ),
  );
  defineBuiltin(
    ObjectConstructor,
    "preventExtensions",
    createNativeFunctionObject("Object.preventExtensions", async (args, context) => {
      const object = toObject(args[0], context);
      if (!(await preventExtensionsGuest(object, context))) {
        throw runtimeError("Unable to prevent extensions for VM object.", {
          reason: "prevent extensions failed",
        });
      }
      return object;
    }),
  );

  defineBuiltin(
    ReflectObject,
    "get",
    createNativeFunctionObject("Reflect.get", async (args, context) =>
      getGuestProperty(
        toObject(args[0], context),
        await toPropertyKey(args[1], context),
        context,
        args.length >= 3 ? args[2] : args[0],
      ),
    ),
  );
  defineBuiltin(
    ReflectObject,
    "set",
    createNativeFunctionObject("Reflect.set", async (args, context) =>
      setGuestProperty(
        toObject(args[0], context),
        await toPropertyKey(args[1], context),
        args[2],
        context,
        args.length >= 4 ? args[3] : args[0],
      ),
    ),
  );
  defineBuiltin(
    ReflectObject,
    "has",
    createNativeFunctionObject("Reflect.has", async (args, context) =>
      hasGuestProperty(args[0], await toPropertyKey(args[1], context), context),
    ),
  );
  defineBuiltin(
    ReflectObject,
    "deleteProperty",
    createNativeFunctionObject("Reflect.deleteProperty", async (args, context) =>
      deleteGuestProperty(
        toObject(args[0], context),
        await toPropertyKey(args[1], context),
        context,
      ),
    ),
  );
  defineBuiltin(
    ReflectObject,
    "ownKeys",
    createNativeFunctionObject("Reflect.ownKeys", async (args, context) =>
      createGuestArray(await ownKeysGuest(toObject(args[0], context), context), context),
    ),
  );
  defineBuiltin(
    ReflectObject,
    "getOwnPropertyDescriptor",
    createNativeFunctionObject("Reflect.getOwnPropertyDescriptor", async (args, context) => {
      const key = await toPropertyKey(args[1], context);
      const descriptor =
        getOwnCallablePropertyDescriptor(args[0], key) ??
        (await getOwnPropertyDescriptorGuest(toObject(args[0], context), key, context));
      return descriptor === undefined
        ? undefined
        : createGuestDescriptorObject(descriptor, context);
    }),
  );
  defineBuiltin(
    ReflectObject,
    "defineProperty",
    createNativeFunctionObject("Reflect.defineProperty", async (args, context) =>
      definePropertyGuest(
        toObject(args[0], context),
        await toPropertyKey(args[1], context),
        await descriptorFromGuestObject(args[2], context),
        context,
      ),
    ),
  );
  defineBuiltin(
    ReflectObject,
    "getPrototypeOf",
    createNativeFunctionObject("Reflect.getPrototypeOf", async (args, context) =>
      getPrototypeOfGuest(toObject(args[0], context), context),
    ),
  );
  defineBuiltin(
    ReflectObject,
    "setPrototypeOf",
    createNativeFunctionObject("Reflect.setPrototypeOf", async (args, context) => {
      const prototype = args[1];
      if (prototype !== null && !isVMObject(prototype)) {
        throwGuestError(
          context,
          "TypeError",
          "Reflect.setPrototypeOf prototype must be a VM object or null.",
        );
      }
      return setPrototypeOfGuest(toObject(args[0], context), prototype, context);
    }),
  );
  defineBuiltin(
    ReflectObject,
    "isExtensible",
    createNativeFunctionObject("Reflect.isExtensible", async (args, context) =>
      isExtensibleGuest(toObject(args[0], context), context),
    ),
  );
  defineBuiltin(
    ReflectObject,
    "preventExtensions",
    createNativeFunctionObject("Reflect.preventExtensions", async (args, context) =>
      preventExtensionsGuest(toObject(args[0], context), context),
    ),
  );
  defineBuiltin(
    ReflectObject,
    "apply",
    createNativeFunctionObject("Reflect.apply", async (args, context) =>
      invokeCallableValue(
        args[0],
        await arrayLikeArgumentList(args[2], context),
        context,
        args[1],
        args[1],
      ),
    ),
  );
  defineBuiltin(
    ReflectObject,
    "construct",
    createNativeFunctionObject("Reflect.construct", async (args, context) => {
      const newTarget = args.length >= 3 ? args[2] : args[0];
      if (newTarget !== args[0]) {
        throw runtimeError("Reflect.construct with a distinct newTarget is not supported yet.", {
          reason: "unsupported newTarget",
        });
      }
      return constructValue(args[0], await arrayLikeArgumentList(args[1], context), context);
    }),
  );

  defineBuiltin(
    ArrayConstructor,
    "isArray",
    createNativeFunctionObject("Array.isArray", (args) => isArrayLikeObject(args[0])),
  );
  defineBuiltin(
    ArrayConstructor,
    "of",
    createNativeFunctionObject("Array.of", (args, context) => createGuestArray(args, context)),
  );
  defineBuiltin(
    ArrayConstructor,
    "from",
    createNativeFunctionObject("Array.from", async (args, context) =>
      createGuestArray(await iterableValuesAsync(args[0], context), context),
    ),
  );

  defineBuiltin(
    SymbolConstructor,
    "for",
    createNativeFunctionObject("Symbol.for", async (args, context) => {
      const key = await toStringForCoercion(args[0], context);
      const registry = getIntrinsics(context).symbolRegistry;
      let symbol = registry.get(key);
      if (symbol === undefined) {
        symbol = createVMSymbol(key, { registryKey: key });
        registry.set(key, symbol);
      }
      return symbol;
    }),
  );
  defineBuiltin(
    SymbolConstructor,
    "keyFor",
    createNativeFunctionObject("Symbol.keyFor", (args, context) => {
      if (!isVMSymbol(args[0])) {
        throwGuestError(context, "TypeError", "Symbol.keyFor requires a symbol.");
      }
      return args[0].registryKey;
    }),
  );
  defineBuiltinData(SymbolConstructor, "iterator", wellKnownSymbols.iterator, {
    configurable: false,
    enumerable: false,
    writable: false,
  });
  defineBuiltinData(SymbolConstructor, "toPrimitive", wellKnownSymbols.toPrimitive, {
    configurable: false,
    enumerable: false,
    writable: false,
  });
  defineBuiltinData(SymbolConstructor, "toStringTag", wellKnownSymbols.toStringTag, {
    configurable: false,
    enumerable: false,
    writable: false,
  });

  defineBuiltin(
    arrayPrototype,
    "map",
    createNativeFunctionObject("Array.prototype.map", async (args, context, thisValue) => {
      const array = toArrayObject(thisValue, context);
      const callback = args[0];
      const values = await getArrayIndexValues(array, context);
      const mapped: VMInternalValue[] = [];
      for (let index = 0; index < values.length; index += 1) {
        mapped.push(
          await invokeCallableValue(
            callback,
            [values[index], index, array],
            context,
            args[1],
            args[1],
          ),
        );
      }
      return createGuestArray(mapped, context);
    }),
  );
  defineBuiltin(
    arrayPrototype,
    "filter",
    createNativeFunctionObject("Array.prototype.filter", async (args, context, thisValue) => {
      const array = toArrayObject(thisValue, context);
      const callback = args[0];
      const output: VMInternalValue[] = [];
      const values = await getArrayIndexValues(array, context);
      for (let index = 0; index < values.length; index += 1) {
        if (
          isTruthy(
            await invokeCallableValue(
              callback,
              [values[index], index, array],
              context,
              args[1],
              args[1],
            ),
          )
        ) {
          output.push(values[index]);
        }
      }
      return createGuestArray(output, context);
    }),
  );
  defineBuiltin(
    arrayPrototype,
    "reduce",
    createNativeFunctionObject("Array.prototype.reduce", async (args, context, thisValue) => {
      const values = await getArrayIndexValues(toArrayObject(thisValue, context), context);
      if (values.length === 0 && args.length < 2) {
        throw runtimeError("Reduce of empty array with no initial value.", {
          reason: "empty reduce",
        });
      }
      let index = args.length >= 2 ? 0 : 1;
      let accumulator = args.length >= 2 ? args[1] : values[0];
      for (; index < values.length; index += 1) {
        accumulator = await invokeCallableValue(
          args[0],
          [accumulator, values[index], index, thisValue],
          context,
          undefined,
        );
      }
      return accumulator;
    }),
  );
  defineBuiltin(
    arrayPrototype,
    "forEach",
    createNativeFunctionObject("Array.prototype.forEach", async (args, context, thisValue) => {
      const array = toArrayObject(thisValue, context);
      const values = await getArrayIndexValues(array, context);
      for (let index = 0; index < values.length; index += 1) {
        await invokeCallableValue(
          args[0],
          [values[index], index, array],
          context,
          args[1],
          args[1],
        );
      }
      return undefined;
    }),
  );
  defineBuiltin(
    arrayPrototype,
    "includes",
    createNativeFunctionObject("Array.prototype.includes", async (args, context, thisValue) => {
      const values = await getArrayIndexValues(toArrayObject(thisValue, context), context);
      const search = args[0];
      const start = Math.max(0, Number(args[1] ?? 0));
      return values.slice(start).some((value) => Object.is(value, search) || value === search);
    }),
  );
  defineBuiltin(
    arrayPrototype,
    "slice",
    createNativeFunctionObject("Array.prototype.slice", async (args, context, thisValue) => {
      const values = await getArrayIndexValues(toArrayObject(thisValue, context), context);
      return createGuestArray(
        values.slice(
          normalizeSliceIndex(args[0], values.length, 0),
          normalizeSliceIndex(args[1], values.length, values.length),
        ),
        context,
      );
    }),
  );
  defineBuiltin(
    arrayPrototype,
    "join",
    createNativeFunctionObject("Array.prototype.join", async (args, context, thisValue) => {
      const values = await getArrayIndexValues(toArrayObject(thisValue, context), context);
      const separator = args[0] === undefined ? "," : String(args[0]);
      return values
        .map((value) => (value === null || value === undefined ? "" : String(value)))
        .join(separator);
    }),
  );
  defineBuiltin(
    arrayPrototype,
    "push",
    createNativeFunctionObject("Array.prototype.push", async (args, context, thisValue) => {
      const array = toArrayObject(thisValue, context);
      const length = await getArrayLengthValue(array, context);
      for (let index = 0; index < args.length; index += 1) {
        await setGuestProperty(array, String(length + index), args[index], context);
      }
      return length + args.length;
    }),
  );
  defineBuiltin(
    arrayPrototype,
    "pop",
    createNativeFunctionObject("Array.prototype.pop", async (_args, context, thisValue) => {
      const array = toArrayObject(thisValue, context);
      const length = await getArrayLengthValue(array, context);
      if (length === 0) {
        defineArrayLengthValue(array, 0);
        return undefined;
      }
      const key = String(length - 1);
      const value = await getGuestProperty(array, key, context);
      await deleteGuestProperty(array, key, context);
      defineArrayLengthValue(array, length - 1);
      return value;
    }),
  );

  defineBuiltin(
    stringPrototype,
    "includes",
    createNativeFunctionObject("String.prototype.includes", (args, _context, thisValue) =>
      String(thisValue ?? "").includes(
        String(args[0]),
        args[1] === undefined ? undefined : Number(args[1]),
      ),
    ),
  );
  defineBuiltin(
    stringPrototype,
    "slice",
    createNativeFunctionObject("String.prototype.slice", (args, _context, thisValue) =>
      String(thisValue ?? "").slice(
        args[0] === undefined ? undefined : Number(args[0]),
        args[1] === undefined ? undefined : Number(args[1]),
      ),
    ),
  );
  defineBuiltin(
    stringPrototype,
    "split",
    createNativeFunctionObject("String.prototype.split", (args, context, thisValue) => {
      const separator = args[0] === undefined ? undefined : String(args[0]);
      const input = String(thisValue ?? "");
      return createGuestArray(
        separator === undefined
          ? [input]
          : input.split(separator, args[1] === undefined ? undefined : Number(args[1])),
        context,
      );
    }),
  );
  defineBuiltin(
    stringPrototype,
    "toUpperCase",
    createNativeFunctionObject("String.prototype.toUpperCase", (_args, _context, thisValue) =>
      String(thisValue ?? "").toUpperCase(),
    ),
  );

  defineBuiltin(
    numberPrototype,
    "valueOf",
    createNativeFunctionObject("Number.prototype.valueOf", (_args, _context, thisValue) =>
      Number(unboxPrimitive(thisValue)),
    ),
  );
  defineBuiltin(
    numberPrototype,
    "toString",
    createNativeFunctionObject("Number.prototype.toString", (_args, _context, thisValue) =>
      String(Number(unboxPrimitive(thisValue))),
    ),
  );
  defineBuiltin(
    bigintPrototype,
    "valueOf",
    createNativeFunctionObject("BigInt.prototype.valueOf", (_args, _context, thisValue) => {
      const value = unboxPrimitive(thisValue);
      if (typeof value !== "bigint") {
        throwGuestError(_context, "TypeError", "BigInt.prototype.valueOf requires a BigInt value.");
      }
      return value;
    }),
  );
  defineBuiltin(
    bigintPrototype,
    "toString",
    createNativeFunctionObject("BigInt.prototype.toString", (_args, _context, thisValue) => {
      const value = unboxPrimitive(thisValue);
      if (typeof value !== "bigint") {
        throwGuestError(
          _context,
          "TypeError",
          "BigInt.prototype.toString requires a BigInt value.",
        );
      }
      return value.toString();
    }),
  );
  defineBuiltin(
    booleanPrototype,
    "valueOf",
    createNativeFunctionObject("Boolean.prototype.valueOf", (_args, _context, thisValue) =>
      Boolean(unboxPrimitive(thisValue)),
    ),
  );
  defineBuiltin(
    booleanPrototype,
    "toString",
    createNativeFunctionObject("Boolean.prototype.toString", (_args, _context, thisValue) =>
      String(Boolean(unboxPrimitive(thisValue))),
    ),
  );
  defineBuiltin(
    symbolPrototype,
    "valueOf",
    createNativeFunctionObject("Symbol.prototype.valueOf", (_args, context, thisValue) => {
      const value = unboxPrimitive(thisValue);
      if (!isVMSymbol(value)) {
        throwGuestError(context, "TypeError", "Symbol.prototype.valueOf requires a Symbol value.");
      }
      return value;
    }),
  );
  defineBuiltin(
    symbolPrototype,
    "toString",
    createNativeFunctionObject("Symbol.prototype.toString", (_args, context, thisValue) => {
      const value = unboxPrimitive(thisValue);
      if (!isVMSymbol(value)) {
        throwGuestError(context, "TypeError", "Symbol.prototype.toString requires a Symbol value.");
      }
      return describeVMSymbol(value);
    }),
  );

  defineBuiltin(
    regexpPrototype,
    "test",
    createNativeFunctionObject(
      "RegExp.prototype.test",
      (args, _context, thisValue) =>
        regexpExecInternal(toRegExpObject(thisValue), String(args[0])).matched,
    ),
  );
  defineBuiltin(
    regexpPrototype,
    "exec",
    createNativeFunctionObject("RegExp.prototype.exec", (args, context, thisValue) => {
      const result = regexpExecInternal(toRegExpObject(thisValue), String(args[0]));
      if (!result.matched || result.match === null) {
        return null;
      }
      const array = createGuestArray(Array.from(result.match), context);
      defineDataProperty(array, "index", result.match.index);
      defineDataProperty(array, "input", result.match.input);
      return array;
    }),
  );

  defineBuiltin(
    DateConstructor,
    "now",
    createNativeFunctionObject(
      "Date.now",
      (_args, context) => getIntrinsics(context).dateNow ?? Date.now(),
    ),
  );
  defineBuiltin(
    DateConstructor,
    "parse",
    createNativeFunctionObject("Date.parse", (args) => Date.parse(String(args[0]))),
  );
  defineBuiltin(
    DateConstructor,
    "UTC",
    createNativeFunctionObject("Date.UTC", (args) => dateUTC(args)),
  );
  defineBuiltin(
    datePrototype,
    "getTime",
    createNativeFunctionObject(
      "Date.prototype.getTime",
      (_args, _context, thisValue) => assertDateSlot(toDateObject(thisValue)).time,
    ),
  );
  defineBuiltin(
    datePrototype,
    "toISOString",
    createNativeFunctionObject("Date.prototype.toISOString", (_args, _context, thisValue) =>
      new Date(assertDateSlot(toDateObject(thisValue)).time).toISOString(),
    ),
  );

  defineBuiltin(
    mapPrototype,
    "get",
    createNativeFunctionObject("Map.prototype.get", (args, _context, thisValue) => {
      const entry = findMapEntry(assertMapSlot(toMapObject(thisValue)), args[0]);
      return entry?.value;
    }),
  );
  defineBuiltin(
    mapPrototype,
    "set",
    createNativeFunctionObject("Map.prototype.set", (args, _context, thisValue) => {
      const map = toMapObject(thisValue);
      const slot = assertMapSlot(map);
      const entry = findMapEntry(slot, args[0]);
      if (entry === undefined) {
        slot.entries.push({ key: args[0], value: args[1] });
      } else {
        entry.value = args[1];
      }
      return map;
    }),
  );
  defineBuiltin(
    mapPrototype,
    "has",
    createNativeFunctionObject(
      "Map.prototype.has",
      (args, _context, thisValue) =>
        findMapEntry(assertMapSlot(toMapObject(thisValue)), args[0]) !== undefined,
    ),
  );
  defineBuiltin(
    mapPrototype,
    "delete",
    createNativeFunctionObject("Map.prototype.delete", (args, _context, thisValue) => {
      const entries = assertMapSlot(toMapObject(thisValue)).entries;
      const index = entries.findIndex((entry) => sameValueZero(entry.key, args[0]));
      if (index < 0) return false;
      entries.splice(index, 1);
      return true;
    }),
  );
  defineBuiltin(
    mapPrototype,
    "clear",
    createNativeFunctionObject("Map.prototype.clear", (_args, _context, thisValue) => {
      assertMapSlot(toMapObject(thisValue)).entries.length = 0;
      return undefined;
    }),
  );
  defineBuiltin(
    mapPrototype,
    "forEach",
    createNativeFunctionObject("Map.prototype.forEach", async (args, context, thisValue) => {
      const map = toMapObject(thisValue);
      for (const entry of [...assertMapSlot(map).entries]) {
        await invokeCallableValue(
          args[0],
          [entry.value, entry.key, map],
          context,
          args[1],
          args[1],
        );
      }
      return undefined;
    }),
  );
  defineBuiltin(
    mapPrototype,
    "size",
    createNativeFunctionObject(
      "get Map.prototype.size",
      (_args, _context, thisValue) => assertMapSlot(toMapObject(thisValue)).entries.length,
    ),
    { accessor: "get" },
  );

  defineBuiltin(
    setPrototype,
    "add",
    createNativeFunctionObject("Set.prototype.add", (args, _context, thisValue) => {
      const set = toSetObject(thisValue);
      const slot = assertSetSlot(set);
      if (!slot.values.some((value) => sameValueZero(value, args[0]))) {
        slot.values.push(args[0]);
      }
      return set;
    }),
  );
  defineBuiltin(
    setPrototype,
    "has",
    createNativeFunctionObject("Set.prototype.has", (args, _context, thisValue) =>
      assertSetSlot(toSetObject(thisValue)).values.some((value) => sameValueZero(value, args[0])),
    ),
  );
  defineBuiltin(
    setPrototype,
    "delete",
    createNativeFunctionObject("Set.prototype.delete", (args, _context, thisValue) => {
      const values = assertSetSlot(toSetObject(thisValue)).values;
      const index = values.findIndex((value) => sameValueZero(value, args[0]));
      if (index < 0) return false;
      values.splice(index, 1);
      return true;
    }),
  );
  defineBuiltin(
    setPrototype,
    "clear",
    createNativeFunctionObject("Set.prototype.clear", (_args, _context, thisValue) => {
      assertSetSlot(toSetObject(thisValue)).values.length = 0;
      return undefined;
    }),
  );
  defineBuiltin(
    setPrototype,
    "forEach",
    createNativeFunctionObject("Set.prototype.forEach", async (args, context, thisValue) => {
      const set = toSetObject(thisValue);
      for (const value of [...assertSetSlot(set).values]) {
        await invokeCallableValue(args[0], [value, value, set], context, args[1], args[1]);
      }
      return undefined;
    }),
  );
  defineBuiltin(
    setPrototype,
    "size",
    createNativeFunctionObject(
      "get Set.prototype.size",
      (_args, _context, thisValue) => assertSetSlot(toSetObject(thisValue)).values.length,
    ),
    { accessor: "get" },
  );

  intrinsics.globals.Object = ObjectConstructor;
  intrinsics.globals.Array = ArrayConstructor;
  intrinsics.globals.String = StringConstructor;
  intrinsics.globals.Number = NumberConstructor;
  intrinsics.globals.BigInt = BigIntConstructor;
  intrinsics.globals.Boolean = BooleanConstructor;
  intrinsics.globals.Symbol = SymbolConstructor;
  intrinsics.globals.RegExp = RegExpConstructor;
  intrinsics.globals.Date = DateConstructor;
  intrinsics.globals.Map = MapConstructor;
  intrinsics.globals.Set = SetConstructor;
  for (const [name, constructor] of Object.entries(errorConstructors)) {
    intrinsics.globals[name] = constructor;
  }
  intrinsics.globals.Reflect = ReflectObject;
  intrinsics.globals.Proxy = ProxyConstructor;
  intrinsics.globals.isNaN = createNativeFunctionObject("isNaN", async (args, context) =>
    Number.isNaN(await toNumber(args[0], context)),
  );
  intrinsics.globals.isFinite = createNativeFunctionObject("isFinite", async (args, context) =>
    Number.isFinite(await toNumber(args[0], context)),
  );

  return Object.freeze(intrinsics);
}

function ArrayConstructorRecord(
  args: readonly VMInternalValue[],
  context: VMExecutionContext,
): VMObject {
  if (args.length === 1 && typeof args[0] === "number") {
    const length = toArrayLength(args[0]);
    const array = createGuestArray([], context);
    defineArrayLengthValue(array, length);
    return array;
  }
  return createGuestArray(args, context);
}

function createErrorConstructors(
  intrinsics: VMIntrinsics,
): Readonly<Record<VMErrorName, VMObject>> {
  const constructors = Object.create(null) as Record<VMErrorName, VMObject>;
  for (const name of Object.keys(intrinsics.errorPrototypes) as VMErrorName[]) {
    const prototype = intrinsics.errorPrototypes[name];
    const constructor = createNativeFunctionObject(
      name,
      (args) => createErrorObject(name, args[0], intrinsics),
      { construct: (args) => createErrorObject(name, args[0], intrinsics) },
    );
    linkConstructor(constructor, prototype, name);
    defineBuiltinData(prototype, "name", name, {
      configurable: true,
      enumerable: false,
      writable: true,
    });
    defineBuiltinData(prototype, "message", "", {
      configurable: true,
      enumerable: false,
      writable: true,
    });
    constructors[name] = constructor;
  }
  return Object.freeze(constructors);
}

function createErrorObject(
  name: VMErrorName,
  messageValue: VMInternalValue,
  intrinsics: VMIntrinsics,
): VMObject {
  const object = createOrdinaryObject(intrinsics.errorPrototypes[name]);
  if (messageValue !== undefined) {
    defineBuiltinData(
      object,
      "message",
      isVMSymbol(messageValue) ? describeVMSymbol(messageValue) : String(messageValue),
      { configurable: true, enumerable: false, writable: true },
    );
  }
  return object;
}

function createNativeFunctionObject(
  name: string,
  call: NativeFunctionHandler,
  options: { readonly construct?: NativeFunctionHandler } = {},
): VMObject {
  const functionObject = createOrdinaryObject();
  nativeFunctionRecords.set(functionObject, { call, construct: options.construct });
  defineBuiltinData(functionObject, "name", name, {
    configurable: true,
    enumerable: false,
    writable: false,
  });
  defineBuiltinData(functionObject, "length", call.length, {
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return functionObject;
}

function createProxyObject(
  targetValue: VMInternalValue,
  handlerValue: VMInternalValue,
  context: VMExecutionContext,
): VMObject {
  if (!isVMObject(targetValue) || !isVMObject(handlerValue)) {
    throw runtimeError("Proxy target and handler must be VM objects.", {
      reason: "invalid proxy arguments",
    });
  }

  const proxy = createOrdinaryObject(getIntrinsics(context).objectPrototype);
  proxySlots.set(proxy, { handler: handlerValue, target: targetValue });
  return proxy;
}

function isProxyObject(value: unknown): value is VMObject {
  return isVMObject(value) && proxySlots.has(value);
}

function getProxySlot(proxy: VMObject): VMProxySlot {
  const slot = proxySlots.get(proxy);
  if (slot === undefined) {
    throw runtimeError("Expected a VM proxy object.", { reason: "missing proxy slot" });
  }
  return slot;
}

async function getTrapMethod(
  handler: VMObject,
  trapName: string,
  context: VMExecutionContext,
): Promise<VMInternalValue | undefined> {
  const trap = await getGuestProperty(handler, trapName, context);
  if (trap === undefined || trap === null) {
    return undefined;
  }
  if (!isCallableValue(trap)) {
    throw runtimeError("Proxy trap must be callable.", {
      path: trapName,
      reason: "invalid proxy trap",
    });
  }
  return trap;
}

async function proxyGet(
  proxy: VMObject,
  key: VMPropertyKey,
  context: VMExecutionContext,
  receiver: VMInternalValue,
): Promise<VMInternalValue> {
  const { handler, target } = getProxySlot(proxy);
  const trap = await getTrapMethod(handler, "get", context);
  if (trap === undefined) {
    return getGuestProperty(target, key, context, receiver);
  }

  const value = await invokeCallableValue(trap, [target, key, receiver], context, handler, handler);
  const descriptor = await getOwnPropertyDescriptorGuest(target, key, context);
  if (descriptor?.configurable === false) {
    if (
      descriptor.kind === "data" &&
      descriptor.writable === false &&
      !sameValueZero(value, descriptor.value)
    ) {
      throw proxyInvariantError(
        "get",
        "cannot report a different value for a non-configurable, non-writable property",
        key,
      );
    }
    if (descriptor.kind === "accessor" && descriptor.get === null && value !== undefined) {
      throw proxyInvariantError(
        "get",
        "cannot report a value for a non-configurable accessor without a getter",
        key,
      );
    }
  }
  return value;
}

async function proxySet(
  proxy: VMObject,
  key: VMPropertyKey,
  value: VMInternalValue,
  context: VMExecutionContext,
  receiver: VMInternalValue,
): Promise<boolean> {
  const { handler, target } = getProxySlot(proxy);
  const trap = await getTrapMethod(handler, "set", context);
  if (trap === undefined) {
    return setGuestProperty(target, key, value, context, receiver);
  }

  const accepted = isTruthy(
    await invokeCallableValue(trap, [target, key, value, receiver], context, handler, handler),
  );
  if (!accepted) {
    return false;
  }

  const descriptor = await getOwnPropertyDescriptorGuest(target, key, context);
  if (descriptor?.configurable === false) {
    if (
      descriptor.kind === "data" &&
      descriptor.writable === false &&
      !sameValueZero(value, descriptor.value)
    ) {
      throw proxyInvariantError(
        "set",
        "cannot change a non-configurable, non-writable property",
        key,
      );
    }
    if (descriptor.kind === "accessor" && descriptor.set === null) {
      throw proxyInvariantError(
        "set",
        "cannot set a non-configurable accessor without a setter",
        key,
      );
    }
  }
  return true;
}

async function proxyHas(
  proxy: VMObject,
  key: VMPropertyKey,
  context: VMExecutionContext,
): Promise<boolean> {
  const { handler, target } = getProxySlot(proxy);
  const trap = await getTrapMethod(handler, "has", context);
  if (trap === undefined) {
    return hasGuestProperty(target, key, context);
  }

  const result = isTruthy(
    await invokeCallableValue(trap, [target, key], context, handler, handler),
  );
  if (!result) {
    const descriptor = await getOwnPropertyDescriptorGuest(target, key, context);
    if (descriptor?.configurable === false) {
      throw proxyInvariantError("has", "cannot hide a non-configurable property", key);
    }
    if (descriptor !== undefined && !(await isExtensibleGuest(target, context))) {
      throw proxyInvariantError("has", "cannot hide a property on a non-extensible target", key);
    }
  }
  return result;
}

async function proxyDeleteProperty(
  proxy: VMObject,
  key: VMPropertyKey,
  context: VMExecutionContext,
): Promise<boolean> {
  const { handler, target } = getProxySlot(proxy);
  const trap = await getTrapMethod(handler, "deleteProperty", context);
  if (trap === undefined) {
    return deleteGuestProperty(target, key, context);
  }

  const result = isTruthy(
    await invokeCallableValue(trap, [target, key], context, handler, handler),
  );
  if (!result) {
    return false;
  }

  const descriptor = await getOwnPropertyDescriptorGuest(target, key, context);
  if (descriptor?.configurable === false) {
    throw proxyInvariantError("deleteProperty", "cannot delete a non-configurable property", key);
  }
  if (descriptor !== undefined && !(await isExtensibleGuest(target, context))) {
    throw proxyInvariantError(
      "deleteProperty",
      "cannot report deletion of a property on a non-extensible target",
      key,
    );
  }
  return true;
}

async function proxyOwnKeys(
  proxy: VMObject,
  context: VMExecutionContext,
): Promise<readonly VMPropertyKey[]> {
  const { handler, target } = getProxySlot(proxy);
  const trap = await getTrapMethod(handler, "ownKeys", context);
  if (trap === undefined) {
    return ownKeysGuest(target, context);
  }

  const keys = await propertyKeyListFromTrapResult(
    await invokeCallableValue(trap, [target], context, handler, handler),
    context,
  );
  const seen = new Set<VMPropertyKey>();
  for (const key of keys) {
    if (seen.has(key)) {
      throw proxyInvariantError("ownKeys", "cannot report duplicate keys", key);
    }
    seen.add(key);
  }

  const targetKeys = await ownKeysGuest(target, context);
  const nonConfigurableKeys: VMPropertyKey[] = [];
  for (const key of targetKeys) {
    const descriptor = await getOwnPropertyDescriptorGuest(target, key, context);
    if (descriptor?.configurable === false) {
      nonConfigurableKeys.push(key);
    }
  }

  for (const key of nonConfigurableKeys) {
    if (!seen.has(key)) {
      throw proxyInvariantError("ownKeys", "cannot omit a non-configurable key", key);
    }
  }

  if (!(await isExtensibleGuest(target, context))) {
    for (const key of targetKeys) {
      if (!seen.has(key)) {
        throw proxyInvariantError(
          "ownKeys",
          "cannot omit target keys for a non-extensible target",
          key,
        );
      }
    }
    const targetKeySet = new Set(targetKeys);
    for (const key of keys) {
      if (!targetKeySet.has(key)) {
        throw proxyInvariantError(
          "ownKeys",
          "cannot report extra keys for a non-extensible target",
          key,
        );
      }
    }
  }

  return Object.freeze(keys);
}

async function proxyGetOwnPropertyDescriptor(
  proxy: VMObject,
  key: VMPropertyKey,
  context: VMExecutionContext,
): Promise<VMPropertyDescriptor | undefined> {
  const { handler, target } = getProxySlot(proxy);
  const trap = await getTrapMethod(handler, "getOwnPropertyDescriptor", context);
  if (trap === undefined) {
    return getOwnPropertyDescriptorGuest(target, key, context);
  }

  const trapResult = await invokeCallableValue(trap, [target, key], context, handler, handler);
  const targetDescriptor = await getOwnPropertyDescriptorGuest(target, key, context);
  const targetExtensible = await isExtensibleGuest(target, context);

  if (trapResult === undefined || trapResult === null) {
    if (targetDescriptor?.configurable === false) {
      throw proxyInvariantError(
        "getOwnPropertyDescriptor",
        "cannot hide a non-configurable property",
        key,
      );
    }
    if (targetDescriptor !== undefined && !targetExtensible) {
      throw proxyInvariantError(
        "getOwnPropertyDescriptor",
        "cannot hide a property on a non-extensible target",
        key,
      );
    }
    return undefined;
  }

  const descriptor = completePropertyDescriptor(
    await descriptorFromGuestObject(trapResult, context),
  );
  validateProxyDescriptorReport(
    "getOwnPropertyDescriptor",
    key,
    descriptor,
    targetDescriptor,
    targetExtensible,
  );
  return descriptor;
}

async function proxyDefineProperty(
  proxy: VMObject,
  key: VMPropertyKey,
  descriptor: VMPropertyDescriptorInput,
  context: VMExecutionContext,
): Promise<boolean> {
  const { handler, target } = getProxySlot(proxy);
  const trap = await getTrapMethod(handler, "defineProperty", context);
  if (trap === undefined) {
    return definePropertyGuest(target, key, descriptor, context);
  }

  const descriptorObject = createGuestDescriptorObject(
    completePropertyDescriptor(descriptor),
    context,
  );
  const accepted = isTruthy(
    await invokeCallableValue(trap, [target, key, descriptorObject], context, handler, handler),
  );
  if (!accepted) {
    return false;
  }

  const completeDescriptor = completePropertyDescriptor(descriptor);
  const targetDescriptor = await getOwnPropertyDescriptorGuest(target, key, context);
  const targetExtensible = await isExtensibleGuest(target, context);
  if (targetDescriptor === undefined && !targetExtensible) {
    throw proxyInvariantError(
      "defineProperty",
      "cannot add a property to a non-extensible target",
      key,
    );
  }
  validateProxyDescriptorReport(
    "defineProperty",
    key,
    completeDescriptor,
    targetDescriptor,
    targetExtensible,
  );
  return true;
}

async function proxyGetPrototypeOf(
  proxy: VMObject,
  context: VMExecutionContext,
): Promise<VMObject | null> {
  const { handler, target } = getProxySlot(proxy);
  const trap = await getTrapMethod(handler, "getPrototypeOf", context);
  if (trap === undefined) {
    return getPrototypeOfGuest(target, context);
  }

  const prototype = await invokeCallableValue(trap, [target], context, handler, handler);
  if (prototype !== null && !isVMObject(prototype)) {
    throw proxyInvariantError("getPrototypeOf", "must report a VM object or null");
  }

  const targetPrototype = await getPrototypeOfGuest(target, context);
  if (!(await isExtensibleGuest(target, context)) && prototype !== targetPrototype) {
    throw proxyInvariantError(
      "getPrototypeOf",
      "cannot report a different prototype for a non-extensible target",
    );
  }
  return prototype;
}

async function proxySetPrototypeOf(
  proxy: VMObject,
  prototype: VMObject | null,
  context: VMExecutionContext,
): Promise<boolean> {
  const { handler, target } = getProxySlot(proxy);
  if (await wouldCreatePrototypeCycleGuest(target, prototype, context)) {
    throw proxyInvariantError("setPrototypeOf", "cannot create a prototype cycle");
  }

  const trap = await getTrapMethod(handler, "setPrototypeOf", context);
  if (trap === undefined) {
    return setPrototypeOfGuest(target, prototype, context);
  }

  const accepted = isTruthy(
    await invokeCallableValue(trap, [target, prototype], context, handler, handler),
  );
  if (!accepted) {
    return false;
  }

  const targetPrototype = await getPrototypeOfGuest(target, context);
  if (!(await isExtensibleGuest(target, context)) && prototype !== targetPrototype) {
    throw proxyInvariantError(
      "setPrototypeOf",
      "cannot change the prototype of a non-extensible target",
    );
  }
  return true;
}

async function proxyIsExtensible(proxy: VMObject, context: VMExecutionContext): Promise<boolean> {
  const { handler, target } = getProxySlot(proxy);
  const trap = await getTrapMethod(handler, "isExtensible", context);
  if (trap === undefined) {
    return isExtensibleGuest(target, context);
  }
  const result = isTruthy(await invokeCallableValue(trap, [target], context, handler, handler));
  const targetResult = await isExtensibleGuest(target, context);
  if (result !== targetResult) {
    throw proxyInvariantError("isExtensible", "must report the target extensibility accurately");
  }
  return result;
}

async function proxyPreventExtensions(
  proxy: VMObject,
  context: VMExecutionContext,
): Promise<boolean> {
  const { handler, target } = getProxySlot(proxy);
  const trap = await getTrapMethod(handler, "preventExtensions", context);
  if (trap === undefined) {
    return preventExtensionsGuest(target, context);
  }
  const accepted = isTruthy(await invokeCallableValue(trap, [target], context, handler, handler));
  if (accepted && (await isExtensibleGuest(target, context))) {
    throw proxyInvariantError(
      "preventExtensions",
      "cannot report success while target is still extensible",
    );
  }
  return accepted;
}

async function proxyApply(
  proxy: VMObject,
  args: readonly VMInternalValue[],
  context: VMExecutionContext,
  thisValue: VMInternalValue | undefined,
  userThisValue: VMInternalValue,
): Promise<VMInternalValue> {
  const { handler, target } = getProxySlot(proxy);
  if (!isCallableValue(target)) {
    throw runtimeError("Proxy target is not callable.", { reason: "not callable" });
  }
  const trap = await getTrapMethod(handler, "apply", context);
  if (trap === undefined) {
    return invokeCallableValue(target, args, context, thisValue, userThisValue);
  }
  return invokeCallableValue(
    trap,
    [target, thisValue, createGuestArray(args, context)],
    context,
    handler,
    handler,
  );
}

async function proxyConstruct(
  proxy: VMObject,
  args: readonly VMInternalValue[],
  context: VMExecutionContext,
): Promise<VMInternalValue> {
  const { handler, target } = getProxySlot(proxy);
  if (!isConstructableValue(target)) {
    throw runtimeError("Proxy target is not constructable.", { reason: "not constructable" });
  }
  const trap = await getTrapMethod(handler, "construct", context);
  if (trap === undefined) {
    return constructValue(target, args, context);
  }
  const result = await invokeCallableValue(
    trap,
    [target, createGuestArray(args, context), proxy],
    context,
    handler,
    handler,
  );
  if (!isVMObject(result)) {
    throw proxyInvariantError("construct", "must return a VM object");
  }
  return result;
}

function linkConstructor(constructor: VMObject, prototype: VMObject, name: string): void {
  defineBuiltinData(constructor, "prototype", prototype, {
    configurable: false,
    enumerable: false,
    writable: false,
  });
  defineBuiltinData(prototype, "constructor", constructor, {
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

function defineBuiltin(
  object: VMObject,
  key: VMPropertyKey,
  value: VMObject,
  options: { readonly accessor?: "get" } = {},
): void {
  const defined =
    options.accessor === "get"
      ? defineOwnProperty(object, key, {
          configurable: true,
          enumerable: false,
          get: value,
          kind: "accessor",
        })
      : defineOwnProperty(object, key, {
          configurable: true,
          enumerable: false,
          kind: "data",
          value,
          writable: true,
        });

  if (!defined) {
    throw runtimeError("Unable to define VM intrinsic property.", {
      path: propertyKeyToString(key),
    });
  }
}

function defineBuiltinData(
  object: VMObject,
  key: VMPropertyKey,
  value: VMInternalValue,
  options: {
    readonly configurable: boolean;
    readonly enumerable: boolean;
    readonly writable: boolean;
  },
): void {
  const defined = defineOwnProperty(object, key, {
    configurable: options.configurable,
    enumerable: options.enumerable,
    kind: "data",
    value,
    writable: options.writable,
  });

  if (!defined) {
    throw runtimeError("Unable to define VM intrinsic data property.", {
      path: propertyKeyToString(key),
    });
  }
}

function getIntrinsics(context: VMExecutionContext): VMIntrinsics {
  let intrinsics = contextIntrinsics.get(context);
  if (intrinsics === undefined) {
    intrinsics = globalObjectIntrinsics.get(context.globalObject);
    if (intrinsics !== undefined) {
      contextIntrinsics.set(context, intrinsics);
    }
  }
  if (intrinsics === undefined) {
    throw runtimeError("VM intrinsics are not installed for this execution context.", {
      reason: "missing intrinsics",
    });
  }
  return intrinsics;
}

function createGuestObject(context: VMExecutionContext): VMObject {
  return createOrdinaryObject(getIntrinsics(context).objectPrototype);
}

function createGuestArray(
  elements: readonly VMInternalValue[],
  context: VMExecutionContext,
): VMObject {
  return createArrayLikeObject(elements, getIntrinsics(context).arrayPrototype);
}

function createPrimitiveWrapper(value: VMInternalValue, intrinsics: VMIntrinsics): VMObject {
  let prototype = intrinsics.objectPrototype;
  if (typeof value === "string") {
    prototype = intrinsics.stringPrototype;
  } else if (typeof value === "number") {
    prototype = intrinsics.numberPrototype;
  } else if (typeof value === "bigint") {
    prototype = intrinsics.bigintPrototype;
  } else if (typeof value === "boolean") {
    prototype = intrinsics.booleanPrototype;
  } else if (isVMSymbol(value)) {
    prototype = intrinsics.symbolPrototype;
  }

  const wrapper = createOrdinaryObject(prototype);
  defineBuiltinData(wrapper, "[[PrimitiveValue]]", value, {
    configurable: false,
    enumerable: false,
    writable: false,
  });
  if (typeof value === "string") {
    defineBuiltinData(wrapper, "length", value.length, {
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
  return wrapper;
}

async function objectToString(
  value: VMInternalValue,
  context: VMExecutionContext,
): Promise<string> {
  if (value === undefined) {
    return "[object Undefined]";
  }
  if (value === null) {
    return "[object Null]";
  }

  const object = toObject(value, context);
  const tag = await getGuestProperty(
    object,
    getIntrinsics(context).wellKnownSymbols.toStringTag,
    context,
  );
  if (typeof tag === "string") {
    return `[object ${tag}]`;
  }
  if (isArrayLikeObject(object)) {
    return "[object Array]";
  }
  if (isCallableValue(object)) {
    return "[object Function]";
  }
  if (regexpSlots.has(object)) {
    return "[object RegExp]";
  }
  if (dateSlots.has(object)) {
    return "[object Date]";
  }
  if (mapSlots.has(object)) {
    return "[object Map]";
  }
  if (setSlots.has(object)) {
    return "[object Set]";
  }
  return "[object Object]";
}

function unboxPrimitive(value: VMInternalValue): VMInternalValue {
  if (!isVMObject(value)) {
    return value;
  }
  const descriptor = getOwnPropertyDescriptor(value, "[[PrimitiveValue]]");
  return descriptor?.kind === "data" ? descriptor.value : value;
}

function toObject(value: VMInternalValue, context: VMExecutionContext): VMObject {
  if (isVMObject(value)) {
    return value;
  }
  if (value === null || value === undefined) {
    throwGuestError(context, "TypeError", "Cannot convert null or undefined to object.");
  }
  return createPrimitiveWrapper(value, getIntrinsics(context));
}

function toArrayObject(value: VMInternalValue | undefined, context: VMExecutionContext): VMObject {
  const object = toObject(value, context);
  if (!isArrayLikeObject(object)) {
    throw runtimeError("Array prototype method requires a VM array.", { reason: "invalid this" });
  }
  return object;
}

function defineArrayLengthValue(array: VMObject, length: number): void {
  if (!defineOwnProperty(array, "length", { kind: "data", value: length })) {
    throw runtimeError("Unable to set VM array length.", { reason: "array length" });
  }
}

function toArrayLength(value: VMInternalValue): number {
  const length = Number(value);
  if (!Number.isInteger(length) || length < 0 || length > 2 ** 32 - 1) {
    throw runtimeError("Invalid array length.", { reason: "invalid array length" });
  }
  return length;
}

async function toBigIntConstructorValue(
  value: VMInternalValue,
  context: VMExecutionContext,
): Promise<bigint> {
  const primitive = await toPrimitive(value, context, "number");
  if (typeof primitive === "bigint") {
    return primitive;
  }
  if (typeof primitive === "boolean") {
    return primitive ? 1n : 0n;
  }
  if (typeof primitive === "string") {
    try {
      return BigInt(primitive);
    } catch {
      throwGuestError(context, "SyntaxError", "Cannot convert string to BigInt.");
    }
  }
  if (typeof primitive === "number") {
    if (!Number.isInteger(primitive)) {
      throwGuestError(
        context,
        "RangeError",
        "The number cannot be converted to a BigInt because it is not an integer.",
      );
    }
    return BigInt(primitive);
  }
  throwGuestError(context, "TypeError", "Cannot convert value to BigInt.");
}

function normalizeSliceIndex(value: VMInternalValue, length: number, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const integer = Math.trunc(Number(value));
  return integer < 0 ? Math.max(length + integer, 0) : Math.min(integer, length);
}

async function descriptorFromGuestObject(
  value: VMInternalValue,
  context: VMExecutionContext,
): Promise<VMPropertyDescriptorInput> {
  const descriptorObject = toObject(value, context);
  const descriptor: Record<string, unknown> = {};
  for (const key of ["value", "writable", "enumerable", "configurable", "get", "set"]) {
    if (await hasGuestProperty(descriptorObject, key, context)) {
      descriptor[key] = await getGuestProperty(descriptorObject, key, context);
    }
  }

  if (hasOwn.call(descriptor, "get") || hasOwn.call(descriptor, "set")) {
    const get = descriptor.get;
    const set = descriptor.set;
    if (get !== undefined && get !== null && !isCallableValue(get)) {
      throwGuestError(
        context,
        "TypeError",
        "Property descriptor getter must be callable or nullish.",
      );
    }
    if (set !== undefined && set !== null && !isCallableValue(set)) {
      throwGuestError(
        context,
        "TypeError",
        "Property descriptor setter must be callable or nullish.",
      );
    }
    return {
      configurable: Boolean(descriptor.configurable),
      enumerable: Boolean(descriptor.enumerable),
      get: get === undefined ? null : (get as VMObject),
      kind: "accessor",
      set: set === undefined ? null : (set as VMObject),
    };
  }

  return {
    configurable: Boolean(descriptor.configurable),
    enumerable: Boolean(descriptor.enumerable),
    kind: "data",
    value: descriptor.value,
    writable: Boolean(descriptor.writable),
  };
}

function createGuestDescriptorObject(
  descriptor: VMPropertyDescriptor,
  context: VMExecutionContext,
): VMObject {
  const object = createGuestObject(context);
  if (descriptor.kind === "data") {
    defineDataProperty(object, "value", descriptor.value);
    defineDataProperty(object, "writable", descriptor.writable);
  } else {
    defineDataProperty(object, "get", descriptor.get ?? undefined);
    defineDataProperty(object, "set", descriptor.set ?? undefined);
  }
  defineDataProperty(object, "enumerable", descriptor.enumerable);
  defineDataProperty(object, "configurable", descriptor.configurable);
  return object;
}

function createRegExpFromArgs(
  args: readonly VMInternalValue[],
  intrinsics: VMIntrinsics,
): VMObject {
  if (isVMObject(args[0]) && regexpSlots.has(args[0]) && args[1] === undefined) {
    const slot = assertRegExpSlot(args[0]);
    return createRegExpObject(
      slot.regexp.source,
      slot.regexp.flags,
      slot.regexp.lastIndex,
      intrinsics,
    );
  }
  return createRegExpObject(
    String(args[0] ?? ""),
    args[1] === undefined ? undefined : String(args[1]),
    0,
    intrinsics,
  );
}

function createRegExpObject(
  source: string,
  flags: string | undefined,
  lastIndex: number,
  intrinsics: VMIntrinsics,
): VMObject {
  const object = createOrdinaryObject(intrinsics.regexpPrototype);
  const regexp = new RegExp(source, flags);
  regexp.lastIndex = lastIndex;
  regexpSlots.set(object, { regexp });
  defineBuiltinData(object, "lastIndex", lastIndex, {
    configurable: false,
    enumerable: false,
    writable: true,
  });
  return object;
}

function assertRegExpSlot(object: VMObject): VMRegExpSlot {
  const slot = regexpSlots.get(object);
  if (slot === undefined) {
    throw runtimeError("RegExp method requires a VM RegExp.", { reason: "invalid this" });
  }
  return slot;
}

function toRegExpObject(value: VMInternalValue | undefined): VMObject {
  if (!isVMObject(value) || !regexpSlots.has(value)) {
    throw runtimeError("RegExp method requires a VM RegExp.", { reason: "invalid this" });
  }
  return value;
}

function regexpExecInternal(
  object: VMObject,
  input: string,
): { readonly matched: boolean; readonly match: RegExpExecArray | null } {
  const slot = assertRegExpSlot(object);
  const lastIndex = getOwnPropertyDescriptor(object, "lastIndex");
  if (lastIndex?.kind === "data") {
    slot.regexp.lastIndex = Number(lastIndex.value);
  }
  const match = slot.regexp.exec(input);
  defineOwnProperty(object, "lastIndex", { kind: "data", value: slot.regexp.lastIndex });
  return { matched: match !== null, match };
}

function createDateFromArgs(args: readonly VMInternalValue[], intrinsics: VMIntrinsics): VMObject {
  if (args.length === 0) {
    return createDateObject(intrinsics.dateNow ?? Date.now(), intrinsics);
  }
  if (args.length === 1) {
    return createDateObject(new Date(args[0] as string | number | Date).getTime(), intrinsics);
  }
  return createDateObject(
    new Date(
      Number(args[0]),
      Number(args[1] ?? 0),
      Number(args[2] ?? 1),
      Number(args[3] ?? 0),
      Number(args[4] ?? 0),
      Number(args[5] ?? 0),
      Number(args[6] ?? 0),
    ).getTime(),
    intrinsics,
  );
}

function createDateObject(time: number, intrinsics: VMIntrinsics): VMObject {
  const object = createOrdinaryObject(intrinsics.datePrototype);
  dateSlots.set(object, { time });
  return object;
}

function assertDateSlot(object: VMObject): VMDateSlot {
  const slot = dateSlots.get(object);
  if (slot === undefined) {
    throw runtimeError("Date method requires a VM Date.", { reason: "invalid this" });
  }
  return slot;
}

function toDateObject(value: VMInternalValue | undefined): VMObject {
  if (!isVMObject(value) || !dateSlots.has(value)) {
    throw runtimeError("Date method requires a VM Date.", { reason: "invalid this" });
  }
  return value;
}

function createMapObject(
  entries: readonly (readonly [VMInternalValue, VMInternalValue])[],
  intrinsics: VMIntrinsics,
): VMObject {
  const object = createOrdinaryObject(intrinsics.mapPrototype);
  mapSlots.set(object, { entries: entries.map(([key, value]) => ({ key, value })) });
  return object;
}

function assertMapSlot(object: VMObject): VMMapSlot {
  const slot = mapSlots.get(object);
  if (slot === undefined) {
    throw runtimeError("Map method requires a VM Map.", { reason: "invalid this" });
  }
  return slot;
}

function toMapObject(value: VMInternalValue | undefined): VMObject {
  if (!isVMObject(value) || !mapSlots.has(value)) {
    throw runtimeError("Map method requires a VM Map.", { reason: "invalid this" });
  }
  return value;
}

function createSetObject(values: readonly VMInternalValue[], intrinsics: VMIntrinsics): VMObject {
  const object = createOrdinaryObject(intrinsics.setPrototype);
  const slot: VMSetSlot = { values: [] };
  for (const value of values) {
    if (!slot.values.some((existing) => sameValueZero(existing, value))) {
      slot.values.push(value);
    }
  }
  setSlots.set(object, slot);
  return object;
}

function assertSetSlot(object: VMObject): VMSetSlot {
  const slot = setSlots.get(object);
  if (slot === undefined) {
    throw runtimeError("Set method requires a VM Set.", { reason: "invalid this" });
  }
  return slot;
}

function toSetObject(value: VMInternalValue | undefined): VMObject {
  if (!isVMObject(value) || !setSlots.has(value)) {
    throw runtimeError("Set method requires a VM Set.", { reason: "invalid this" });
  }
  return value;
}

function findMapEntry(
  slot: VMMapSlot,
  key: VMInternalValue,
): { key: VMInternalValue; value: VMInternalValue } | undefined {
  return slot.entries.find((entry) => sameValueZero(entry.key, key));
}

function sameValueZero(left: VMInternalValue, right: VMInternalValue): boolean {
  return left === right || (Number.isNaN(left) && Number.isNaN(right));
}

async function iterableEntries(
  value: VMInternalValue,
  context: VMExecutionContext,
): Promise<readonly (readonly [VMInternalValue, VMInternalValue])[]> {
  if (value === undefined || value === null) {
    return [];
  }
  if (isVMObject(value) && mapSlots.has(value)) {
    return assertMapSlot(value).entries.map((entry) => [entry.key, entry.value] as const);
  }
  if (isArrayLikeObject(value)) {
    const keys = await ownKeysGuest(value, context);
    const entries: Array<readonly [VMInternalValue, VMInternalValue]> = [];
    for (const key of keys.filter(
      (key): key is string => typeof key === "string" && isArrayIndex(key),
    )) {
      const entry = await getGuestProperty(value, key, context);
      if (!isArrayLikeObject(entry)) {
        throw runtimeError("Map iterable entries must be VM arrays.", {
          reason: "invalid iterable",
        });
      }
      entries.push([
        await getGuestProperty(entry, "0", context),
        await getGuestProperty(entry, "1", context),
      ] as const);
    }
    return entries;
  }
  if (isVMObject(value) && setSlots.has(value)) {
    return assertSetSlot(value).values.map((entry) => [entry, entry] as const);
  }
  throw runtimeError("Value is not iterable by VM collection constructors.", {
    reason: "unsupported iterator",
    valueType: guestTypeof(value),
  });
}

async function iterableValues(
  value: VMInternalValue,
  context: VMExecutionContext,
): Promise<readonly VMInternalValue[]> {
  if (value === undefined || value === null) {
    return [];
  }
  if (isVMObject(value) && setSlots.has(value)) {
    return [...assertSetSlot(value).values];
  }
  if (isVMObject(value) && mapSlots.has(value)) {
    return assertMapSlot(value).entries.map((entry) =>
      createGuestArray([entry.key, entry.value], context),
    );
  }
  if (isArrayLikeObject(value)) {
    const values: VMInternalValue[] = [];
    for (const key of (await ownKeysGuest(value, context)).filter(
      (key): key is string => typeof key === "string" && isArrayIndex(key),
    )) {
      values.push(await getGuestProperty(value, key, context));
    }
    return values;
  }
  if (typeof value === "string") {
    return [...value];
  }
  throw runtimeError("Value is not iterable by VM collection constructors.", {
    reason: "unsupported iterator",
    valueType: guestTypeof(value),
  });
}

async function iterableValuesAsync(
  value: VMInternalValue,
  context: VMExecutionContext,
): Promise<readonly VMInternalValue[]> {
  if (value === undefined || value === null) {
    throw runtimeError("Array.from requires an iterable or array-like value.", {
      reason: "nullish iterable",
    });
  }
  if (typeof value === "string") {
    return [...value];
  }
  if (isVMObject(value) && setSlots.has(value)) {
    return [...assertSetSlot(value).values];
  }
  if (isVMObject(value) && mapSlots.has(value)) {
    return assertMapSlot(value).entries.map((entry) =>
      createGuestArray([entry.key, entry.value], context),
    );
  }
  const object = toObject(value, context);
  if (isArrayLikeObject(object)) {
    return getArrayIndexValues(object, context);
  }
  const length = await getGuestProperty(object, "length", context);
  if (typeof length === "number") {
    const output: VMInternalValue[] = [];
    for (let index = 0; index < toArrayLength(length); index += 1) {
      output.push(await getGuestProperty(object, String(index), context));
    }
    return output;
  }
  throw runtimeError("Array.from requires an iterable or array-like value.", {
    reason: "unsupported iterator",
  });
}

function createArrayBufferObject(buffer: ArrayBuffer, intrinsics: VMIntrinsics): VMObject {
  const object = createOrdinaryObject(intrinsics.arrayBufferPrototype);
  const copy = buffer.slice(0);
  arrayBufferSlots.set(object, copy);
  defineBuiltinData(object, "byteLength", copy.byteLength, {
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return object;
}

function createTypedArrayObject(
  type: string,
  bytes: readonly number[],
  intrinsics: VMIntrinsics,
): VMObject {
  const object = createArrayLikeObject([], intrinsics.typedArrayPrototype);
  typedArraySlots.set(object, { bytes: [...bytes], type });
  defineBuiltinData(object, "byteLength", bytes.length, {
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return object;
}

function createDataViewObject(bytes: readonly number[], intrinsics: VMIntrinsics): VMObject {
  const object = createOrdinaryObject(intrinsics.dataViewPrototype);
  dataViewSlots.set(object, [...bytes]);
  defineBuiltinData(object, "byteLength", bytes.length, {
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return object;
}

function bytesToArrayBuffer(bytes: readonly number[]): ArrayBuffer {
  const output = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    output[index] = bytes[index];
  }
  return output.buffer;
}

function reconstructTypedArrayForBoundary(type: string, bytes: readonly number[]): VMInternalValue {
  const buffer = bytesToArrayBuffer(bytes);
  switch (type) {
    case "Int8Array":
      return new Int8Array(buffer);
    case "Uint8Array":
      return new Uint8Array(buffer);
    case "Uint8ClampedArray":
      return new Uint8ClampedArray(buffer);
    case "Int16Array":
      return new Int16Array(buffer);
    case "Uint16Array":
      return new Uint16Array(buffer);
    case "Int32Array":
      return new Int32Array(buffer);
    case "Uint32Array":
      return new Uint32Array(buffer);
    case "Float32Array":
      return new Float32Array(buffer);
    case "Float64Array":
      return new Float64Array(buffer);
    case "BigInt64Array":
      return new BigInt64Array(buffer);
    case "BigUint64Array":
      return new BigUint64Array(buffer);
    default:
      return new Uint8Array(buffer);
  }
}

function dateUTC(args: readonly unknown[]): number {
  return Date.UTC(
    Number(args[0] ?? 0),
    Number(args[1] ?? 0),
    Number(args[2] ?? 1),
    Number(args[3] ?? 0),
    Number(args[4] ?? 0),
    Number(args[5] ?? 0),
    Number(args[6] ?? 0),
  );
}

function createDynamicCodeConstructor(isAsync: boolean): VMNativeCallable {
  const name = isAsync ? "AsyncFunction" : "Function";
  const handler = (args: readonly unknown[], context: unknown): VMInternalValue =>
    createDynamicCodeFunction(args, asExecutionContext(context), isAsync);

  return createNativeCallable(name, handler, {
    arity: 1,
    construct: handler,
    description: `VM-owned ${name} constructor`,
  });
}

function asExecutionContext(context: unknown): VMExecutionContext {
  if (context instanceof VMExecutionContext) {
    return context;
  }

  throw runtimeError("Dynamic code requires a VM execution context.", {
    reason: "invalid execution context",
  });
}

async function evaluateDynamicSourceArgument(
  source: unknown,
  context: VMExecutionContext,
  direct: boolean,
): Promise<VMInternalValue> {
  if (typeof source !== "string") {
    return source;
  }

  const program = parseProgram(source, {
    sourceFile: direct ? "<direct-eval>" : "<indirect-eval>",
  });

  return executeDynamicProgram(program as unknown as ASTNode, context, direct);
}

async function executeDynamicProgram(
  program: ASTNode,
  context: VMExecutionContext,
  direct: boolean,
): Promise<VMInternalValue> {
  if (direct) {
    return unwrapDynamicCompletion(await executeProgram(program, context));
  }

  const previousLexical = context.lexicalEnvironment;
  const previousVariable = context.variableEnvironment;
  const previousThis = context.thisValue;

  context.lexicalEnvironment = context.globalEnvironment;
  context.variableEnvironment = context.globalEnvironment;
  context.thisValue = context.globalObject;

  try {
    return unwrapDynamicCompletion(await executeProgram(program, context));
  } finally {
    context.lexicalEnvironment = previousLexical;
    context.variableEnvironment = previousVariable;
    context.thisValue = previousThis;
  }
}

function unwrapDynamicCompletion(completion: VMCompletion): VMInternalValue {
  if (completion.type === "normal") {
    return completion.value;
  }

  if (completion.type === "return") {
    throw runtimeError("Return statements are only valid inside guest functions.", {
      reason: "unexpected return completion",
    });
  }

  if (completion.type === "break" || completion.type === "continue") {
    throw runtimeError(`${completion.type} statements must target a loop.`, {
      reason: `unexpected ${completion.type} completion`,
    });
  }

  throw runtimeError("Guest code threw a value.", {
    reason: "throw completion",
    valueType: guestTypeof(completion.value),
  });
}

function createDynamicCodeFunction(
  args: readonly unknown[],
  context: VMExecutionContext,
  isAsync: boolean,
): VMUserFunction {
  const { body, parameters } = getDynamicCodeParts(args);
  const source = buildDynamicCodeFunctionSource(parameters, body, isAsync);
  const program = parseProgram(source, {
    sourceFile: isAsync ? "<async-function-constructor>" : "<function-constructor>",
  });
  const node = getDynamicCodeFunctionNode(program as unknown as ASTNode, isAsync);
  return createUserFunctionInGlobalScope(node, context);
}

function getDynamicCodeParts(args: readonly unknown[]): {
  readonly body: string;
  readonly parameters: string;
} {
  if (args.length === 0) {
    return { body: "", parameters: "" };
  }

  return {
    body: String(args[args.length - 1]),
    parameters: args
      .slice(0, -1)
      .map((arg) => String(arg))
      .join(","),
  };
}

function buildDynamicCodeFunctionSource(
  parameters: string,
  body: string,
  isAsync: boolean,
): string {
  const prefix = isAsync ? "(async function anonymous(" : "(function anonymous(";
  return `${prefix}${parameters}) {\n${body}\n})`;
}

function getDynamicCodeFunctionNode(program: ASTNode, isAsync: boolean): ASTNode {
  assertNodeType(program, "Program");
  const body = getNodeArray(program, "body");
  if (body.length !== 1 || body[0].type !== "ExpressionStatement") {
    throw syntaxError("Dynamic function source must produce exactly one function expression.");
  }

  const expression = getNode(body[0], "expression");
  if (expression.type !== "FunctionExpression" || expression.async !== isAsync) {
    throw syntaxError("Dynamic function source did not produce the expected function kind.");
  }

  return expression;
}

function createUserFunctionInGlobalScope(
  node: ASTNode,
  context: VMExecutionContext,
): VMUserFunction {
  const previousLexical = context.lexicalEnvironment;
  const previousVariable = context.variableEnvironment;
  const previousThis = context.thisValue;

  context.lexicalEnvironment = context.globalEnvironment;
  context.variableEnvironment = context.globalEnvironment;
  context.thisValue = context.globalObject;

  try {
    return createUserFunction(node, context, "anonymous");
  } finally {
    context.lexicalEnvironment = previousLexical;
    context.variableEnvironment = previousVariable;
    context.thisValue = previousThis;
  }
}

function isDynamicCodeEvaluator(value: unknown): boolean {
  return isNativeCallable(value) && dynamicEvalCallables.has(value);
}

function defineGlobalBinding(
  environment: VMEnvironment,
  globalObject: VMObject,
  name: string,
  value: VMInternalValue,
  options: {
    readonly configurable: boolean;
    readonly deletable: boolean;
    readonly enumerable: boolean;
    readonly mutable: boolean;
    readonly writable: boolean;
  },
): void {
  environment.define(name, {
    kind: "var",
    mutable: options.mutable,
    deletable: options.deletable,
    initialized: true,
    value,
  });
  defineGlobalObjectProperty(globalObject, name, value, options);
}

function defineGlobalObjectProperty(
  globalObject: VMObject,
  name: string,
  value: VMInternalValue,
  options: {
    readonly configurable: boolean;
    readonly enumerable: boolean;
    readonly writable: boolean;
  } = { configurable: true, enumerable: true, writable: true },
): void {
  const defined = defineOwnProperty(globalObject, name, {
    configurable: options.configurable,
    enumerable: options.enumerable,
    kind: "data",
    value,
    writable: options.writable,
  });

  if (!defined) {
    throw runtimeError("Unable to define VM global object property.", {
      path: name,
      reason: "property definition failed",
    });
  }
}

export async function evaluateSource(
  source: string,
  options: VMEvaluatorOptions = {},
): Promise<VMSerializableValue> {
  return evaluateProgram(parseProgram(source), options);
}

export async function evaluateProgram(
  program: VMProgram,
  options: VMEvaluatorOptions = {},
): Promise<VMSerializableValue> {
  const context = options.context ?? createEvaluatorContext(options);

  try {
    const completion = await executeProgram(program as unknown as ASTNode, context);

    if (completion.type === "return") {
      throw runtimeError("Return statements are only valid inside guest functions.", {
        reason: "unexpected return completion",
      });
    }

    if (completion.type === "break" || completion.type === "continue") {
      throw runtimeError(`${completion.type} statements must target a loop.`, {
        reason: `unexpected ${completion.type} completion`,
      });
    }

    if (completion.type === "throw") {
      throw runtimeError("Guest code threw a value.", {
        reason: "throw completion",
        valueType: guestTypeof(completion.value),
      });
    }

    return await exportGuestValue(completion.value, context);
  } catch (error) {
    if (error instanceof VMGuestException) {
      throw runtimeError("Guest code threw a value.", {
        reason: "throw completion",
        valueType: guestTypeof(error.value),
      });
    }
    throw normalizeEvaluatorError(error);
  }
}

export async function executeProgramForSideEffects(
  program: VMProgram,
  options: VMEvaluatorOptions = {},
): Promise<void> {
  const context = options.context ?? createEvaluatorContext(options);

  try {
    const completion = await executeProgram(program as unknown as ASTNode, context);

    if (completion.type === "return") {
      throw runtimeError("Return statements are only valid inside guest functions.", {
        reason: "unexpected return completion",
      });
    }

    if (completion.type === "break" || completion.type === "continue") {
      throw runtimeError(`${completion.type} statements must target a loop.`, {
        reason: `unexpected ${completion.type} completion`,
      });
    }

    if (completion.type === "throw") {
      throw runtimeError("Guest code threw a value.", {
        reason: "throw completion",
        valueType: guestTypeof(completion.value),
      });
    }
  } catch (error) {
    if (error instanceof VMGuestException) {
      throw runtimeError("Guest code threw a value.", {
        reason: "throw completion",
        valueType: guestTypeof(error.value),
      });
    }
    throw normalizeEvaluatorError(error);
  }
}

export function isGuestCallableValue(value: unknown): boolean {
  return isCallableValue(value);
}

export async function exportGuestValueForHost(
  value: unknown,
  context: VMExecutionContext,
): Promise<VMSerializableValue> {
  try {
    return await exportGuestValue(value as VMInternalValue, context);
  } catch (error) {
    if (error instanceof VMGuestException) {
      throw runtimeError("Guest code threw a value.", {
        reason: "throw completion",
        valueType: guestTypeof(error.value),
      });
    }
    throw normalizeEvaluatorError(error);
  }
}

export async function invokeGuestCallableForHost(
  callable: unknown,
  args: readonly VMSerializableValue[],
  context: VMExecutionContext,
  thisValue?: unknown,
): Promise<VMSerializableValue> {
  try {
    const intrinsics = getIntrinsics(context);
    const importedArgs = args.map((arg, index) =>
      importGuestValue(arg, `<host-rpc-arg>[${index}]`, intrinsics),
    );
    const result = await invokeCallableValue(
      callable as VMInternalValue,
      importedArgs,
      context,
      thisValue as VMInternalValue | undefined,
      (thisValue as VMInternalValue | undefined) ?? context.globalObject,
    );

    return await exportGuestValue(result, context);
  } catch (error) {
    if (error instanceof VMGuestException) {
      throw runtimeError("Guest code threw a value.", {
        reason: "throw completion",
        valueType: guestTypeof(error.value),
      });
    }
    throw normalizeEvaluatorError(error);
  }
}

export async function serializeGuestValueForSnapshot(
  value: unknown,
  context: VMExecutionContext,
  path = "$",
): Promise<VMSerializedValue> {
  return serializeBoundaryValue(
    await prepareGuestValueForBoundary(value, path, new WeakSet<object>(), context),
    { allowCapabilities: false },
  );
}

async function executeProgram(
  program: ASTNode,
  context: VMExecutionContext,
): Promise<VMCompletion> {
  assertNodeType(program, "Program");
  const body = getNodeArray(program, "body");
  hoistFunctionDeclarations(body, context, context.lexicalEnvironment);
  return executeStatementList(body, context);
}

async function executeStatementList(
  statements: readonly ASTNode[],
  context: VMExecutionContext,
): Promise<VMCompletion> {
  let lastValue: VMInternalValue;

  for (const statement of statements) {
    context.checkpoint(1, statement.type);
    const completion = await executeStatement(statement, context);

    if (completion.type !== "normal") {
      return completion;
    }

    if (hasCompletionValue(completion)) {
      lastValue = completion.value;
    }
  }

  return normalCompletion(lastValue);
}

async function executeStatement(
  statement: ASTNode,
  context: VMExecutionContext,
): Promise<VMCompletion> {
  switch (statement.type) {
    case "EmptyStatement":
      return normalCompletion();
    case "ExpressionStatement":
      return normalCompletion(await evaluateExpression(getNode(statement, "expression"), context));
    case "BlockStatement":
      return executeBlockStatement(statement, context);
    case "VariableDeclaration":
      await executeVariableDeclaration(statement, context);
      return normalCompletion();
    case "FunctionDeclaration":
      return normalCompletion();
    case "ClassDeclaration":
      await executeClassDeclaration(statement, context);
      return normalCompletion();
    case "IfStatement":
      return executeIfStatement(statement, context);
    case "WhileStatement":
      return executeWhileStatement(statement, context);
    case "DoWhileStatement":
      return executeDoWhileStatement(statement, context);
    case "ForStatement":
      return executeForStatement(statement, context);
    case "ForInStatement":
      return executeForInStatement(statement, context);
    case "ForOfStatement":
      return executeForOfStatement(statement, context);
    case "SwitchStatement":
      return executeSwitchStatement(statement, context);
    case "TryStatement":
      return executeTryStatement(statement, context);
    case "LabeledStatement":
      return executeLabeledStatement(statement, context);
    case "BreakStatement":
      return breakCompletion(getOptionalIdentifierName(statement, "label"));
    case "ContinueStatement":
      return continueCompletion(getOptionalIdentifierName(statement, "label"));
    case "ReturnStatement":
      return returnCompletion(
        statement.argument === null || statement.argument === undefined
          ? undefined
          : await evaluateExpression(getNode(statement, "argument"), context),
      );
    case "ThrowStatement":
      return throwCompletion(await evaluateExpression(getNode(statement, "argument"), context));
    default:
      throw unsupportedNode(statement);
  }
}

async function executeClassDeclaration(
  declaration: ASTNode,
  context: VMExecutionContext,
): Promise<void> {
  const name = getOptionalIdentifierName(declaration, "id");
  if (name === undefined) {
    throw unsupportedNode(declaration, "Class declarations must be named.");
  }
  assertSafeBindingName(name);

  const target = context.lexicalEnvironment;
  if (!target.hasOwn(name)) {
    target.define(name, { kind: "const", mutable: false, deletable: false, initialized: false });
  }

  await evaluateClass(declaration, context, {
    nameHint: name,
    initializeName(value) {
      target.initialize(name, value);
    },
  });
}

async function executeBlockStatement(
  statement: ASTNode,
  context: VMExecutionContext,
): Promise<VMCompletion> {
  const environment = context.enterLexicalEnvironment();

  try {
    const body = getNodeArray(statement, "body");
    hoistFunctionDeclarations(body, context, environment);
    return await executeStatementList(body, context);
  } finally {
    context.leaveLexicalEnvironment(environment);
  }
}

async function executeIfStatement(
  statement: ASTNode,
  context: VMExecutionContext,
): Promise<VMCompletion> {
  if (isTruthy(await evaluateExpression(getNode(statement, "test"), context))) {
    return executeStatement(getNode(statement, "consequent"), context);
  }

  const alternate = statement.alternate;
  return alternate === null || alternate === undefined
    ? normalCompletion()
    : executeStatement(asNode(alternate), context);
}

async function executeWhileStatement(
  statement: ASTNode,
  context: VMExecutionContext,
): Promise<VMCompletion> {
  while (isTruthy(await evaluateExpression(getNode(statement, "test"), context))) {
    context.checkpoint(1, "while iteration");
    const completion = await executeStatement(getNode(statement, "body"), context);

    if (completion.type === "break") {
      return normalCompletion();
    }

    if (completion.type === "continue") {
      continue;
    }

    if (completion.type !== "normal") {
      return completion;
    }
  }

  return normalCompletion();
}

async function executeDoWhileStatement(
  statement: ASTNode,
  context: VMExecutionContext,
): Promise<VMCompletion> {
  do {
    context.checkpoint(1, "do-while iteration");
    const completion = await executeStatement(getNode(statement, "body"), context);

    if (completion.type === "break") {
      return normalCompletion();
    }

    if (completion.type !== "normal" && completion.type !== "continue") {
      return completion;
    }
  } while (isTruthy(await evaluateExpression(getNode(statement, "test"), context)));

  return normalCompletion();
}

async function executeForStatement(
  statement: ASTNode,
  context: VMExecutionContext,
): Promise<VMCompletion> {
  const environment = context.enterLexicalEnvironment();

  try {
    const init = statement.init;
    if (init !== null && init !== undefined) {
      const initNode = asNode(init);
      if (initNode.type === "VariableDeclaration") {
        await executeVariableDeclaration(initNode, context);
      } else {
        await evaluateExpression(initNode, context);
      }
    }

    while (true) {
      const test = statement.test;
      if (
        test !== null &&
        test !== undefined &&
        !isTruthy(await evaluateExpression(asNode(test), context))
      ) {
        return normalCompletion();
      }

      context.checkpoint(1, "for iteration");
      const completion = await executeStatement(getNode(statement, "body"), context);

      if (completion.type === "break") {
        return normalCompletion();
      }

      if (completion.type !== "normal" && completion.type !== "continue") {
        return completion;
      }

      const update = statement.update;
      if (update !== null && update !== undefined) {
        await evaluateExpression(asNode(update), context);
      }
    }
  } finally {
    context.leaveLexicalEnvironment(environment);
  }
}

async function executeForInStatement(
  statement: ASTNode,
  context: VMExecutionContext,
): Promise<VMCompletion> {
  const environment = context.enterLexicalEnvironment();

  try {
    const right = asGuestObject(await evaluateExpression(getNode(statement, "right"), context));
    const keys = await getEnumerableOwnStringKeys(right, context);

    for (const key of keys) {
      context.checkpoint(1, "for-in iteration");
      await assignLoopLeft(getNode(statement, "left"), key, context);
      const completion = await executeStatement(getNode(statement, "body"), context);

      if (completion.type === "break") {
        return normalCompletion();
      }

      if (completion.type !== "normal" && completion.type !== "continue") {
        return completion;
      }
    }

    return normalCompletion();
  } finally {
    context.leaveLexicalEnvironment(environment);
  }
}

async function executeForOfStatement(
  statement: ASTNode,
  context: VMExecutionContext,
): Promise<VMCompletion> {
  const environment = context.enterLexicalEnvironment();

  try {
    const right = await evaluateExpression(getNode(statement, "right"), context);
    const values = await getForOfValues(right, context);

    for (const value of values) {
      context.checkpoint(1, "for-of iteration");
      await assignLoopLeft(getNode(statement, "left"), value, context);
      const completion = await executeStatement(getNode(statement, "body"), context);

      if (completion.type === "break") {
        return normalCompletion();
      }

      if (completion.type !== "normal" && completion.type !== "continue") {
        return completion;
      }
    }

    return normalCompletion();
  } finally {
    context.leaveLexicalEnvironment(environment);
  }
}

async function executeSwitchStatement(
  statement: ASTNode,
  context: VMExecutionContext,
): Promise<VMCompletion> {
  const discriminant = await evaluateExpression(getNode(statement, "discriminant"), context);
  const cases = getNodeArray(statement, "cases");
  let matched = false;
  let defaultIndex = -1;
  let lastValue: VMInternalValue = undefined;

  for (let index = 0; index < cases.length; index += 1) {
    if (cases[index].test === null || cases[index].test === undefined) {
      defaultIndex = index;
      continue;
    }

    if (discriminant === (await evaluateExpression(asNode(cases[index].test), context))) {
      matched = true;
      defaultIndex = index;
      break;
    }
  }

  if (defaultIndex === -1) {
    return normalCompletion();
  }

  for (let index = defaultIndex; index < cases.length; index += 1) {
    if (!matched && cases[index].test !== null && cases[index].test !== undefined) {
      continue;
    }
    matched = true;

    const completion = await executeStatementList(
      getNodeArray(cases[index], "consequent"),
      context,
    );
    if (completion.type === "break") {
      return normalCompletion();
    }

    if (completion.type !== "normal") {
      return completion;
    }

    if (hasCompletionValue(completion)) {
      lastValue = completion.value;
    }
  }

  return normalCompletion(lastValue);
}

async function executeTryStatement(
  statement: ASTNode,
  context: VMExecutionContext,
): Promise<VMCompletion> {
  let completion: VMCompletion;
  try {
    completion = await executeStatement(getNode(statement, "block"), context);
  } catch (error) {
    if (!(error instanceof VMGuestException)) {
      throw error;
    }
    completion = throwCompletion(error.value);
  }
  const handler =
    statement.handler === null || statement.handler === undefined
      ? undefined
      : asNode(statement.handler);

  if (completion.type === "throw" && handler !== undefined) {
    const environment = context.enterLexicalEnvironment();
    try {
      const param = handler.param;
      if (param !== null && param !== undefined) {
        const paramNode = asNode(param);
        await bindPattern(paramNode, completion.value, context, {
          environment,
          kind: "let",
          mutable: true,
        });
      }
      completion = await executeStatement(getNode(handler, "body"), context);
    } finally {
      context.leaveLexicalEnvironment(environment);
    }
  }

  const finalizer = statement.finalizer;
  if (finalizer !== null && finalizer !== undefined) {
    const finalizerCompletion = await executeStatement(asNode(finalizer), context);
    if (finalizerCompletion.type !== "normal") {
      return finalizerCompletion;
    }
  }

  return completion;
}

async function executeLabeledStatement(
  statement: ASTNode,
  context: VMExecutionContext,
): Promise<VMCompletion> {
  const label = getOptionalIdentifierName(statement, "label");
  const completion = await executeStatement(getNode(statement, "body"), context);

  if (completion.type === "break" && completion.target === label) {
    return normalCompletion();
  }

  return completion;
}

async function executeVariableDeclaration(
  declaration: ASTNode,
  context: VMExecutionContext,
): Promise<void> {
  const kind = getString(declaration, "kind") as "var" | "let" | "const";
  const target = kind === "var" ? context.variableEnvironment : context.lexicalEnvironment;

  for (const declarator of getNodeArray(declaration, "declarations")) {
    const id = getNode(declarator, "id");
    const init = declarator.init;
    const value =
      init === null || init === undefined
        ? undefined
        : await evaluateExpression(asNode(init), context);

    if (id.type !== "Identifier") {
      if (init === null || init === undefined) {
        throw unsupportedNode(id, "Destructuring declarations require an initializer.");
      }
      await bindPattern(id, value, context, { environment: target, kind });
      continue;
    }

    const name = getString(id, "name");
    assertSafeBindingName(name);

    if (kind === "var") {
      if (!target.hasOwn(name)) {
        target.define(name, { kind: "var", mutable: true, deletable: true, initialized: true });
        if (target === context.globalEnvironment) {
          defineGlobalObjectProperty(context.globalObject, name, undefined);
        }
      }
      if (init !== null && init !== undefined) {
        target.set(name, value);
        if (target === context.globalEnvironment) {
          setGlobalObjectProperty(context.globalObject, name, value);
        }
      }
      continue;
    }

    target.define(name, {
      kind,
      mutable: kind !== "const",
      deletable: false,
      initialized: true,
      value,
    });
  }
}

async function evaluateExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<VMInternalValue> {
  context.checkpoint(1, expression.type);

  switch (expression.type) {
    case "Literal":
      return evaluateLiteral(expression, context);
    case "Identifier": {
      const name = getString(expression, "name");
      return createBindingReference(name, context).get();
    }
    case "ThisExpression":
      return getThisValue(context);
    case "ArrayExpression":
      return evaluateArrayExpression(expression, context);
    case "ObjectExpression":
      return evaluateObjectExpression(expression, context);
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return createUserFunction(expression, context, getOptionalIdentifierName(expression, "id"));
    case "ClassExpression":
      return evaluateClass(expression, context, {
        nameHint: getOptionalIdentifierName(expression, "id"),
      });
    case "AssignmentExpression":
      return evaluateAssignmentExpression(expression, context);
    case "UpdateExpression":
      return evaluateUpdateExpression(expression, context);
    case "BinaryExpression":
      return evaluateBinaryExpression(expression, context);
    case "LogicalExpression":
      return evaluateLogicalExpression(expression, context);
    case "UnaryExpression":
      return evaluateUnaryExpression(expression, context);
    case "ConditionalExpression":
      return isTruthy(await evaluateExpression(getNode(expression, "test"), context))
        ? evaluateExpression(getNode(expression, "consequent"), context)
        : evaluateExpression(getNode(expression, "alternate"), context);
    case "CallExpression":
      return evaluateCallExpression(expression, context);
    case "NewExpression":
      return evaluateNewExpression(expression, context);
    case "ImportExpression":
      throw securityError("Guest code cannot dynamically import modules.", {
        reason: "dynamic import",
      });
    case "AwaitExpression":
      return await evaluateExpression(getNode(expression, "argument"), context);
    case "MemberExpression":
      return (await evaluateReference(expression, context)).get();
    case "ChainExpression":
      return evaluateChainExpression(expression, context);
    case "TemplateLiteral":
      return evaluateTemplateLiteral(expression, context);
    case "SequenceExpression": {
      let value: VMInternalValue;
      for (const item of getNodeArray(expression, "expressions")) {
        value = await evaluateExpression(item, context);
      }
      return value;
    }
    default:
      throw unsupportedNode(expression);
  }
}

function evaluateLiteral(expression: ASTNode, context: VMExecutionContext): VMInternalValue {
  if (hasOwn.call(expression, "regex") && expression.regex !== undefined) {
    const regex = asRecord(expression.regex, "regular expression literal");
    if (typeof regex.pattern !== "string" || typeof regex.flags !== "string") {
      throw runtimeError("Invalid RegExp literal.", { reason: "invalid ast" });
    }
    return createRegExpObject(regex.pattern, regex.flags, 0, getIntrinsics(context));
  }

  return expression.value;
}

async function evaluateArrayExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<VMObject> {
  const array = createGuestArray([], context);
  const elements = getUnknownArray(expression, "elements");
  let nextIndex = 0;

  for (const element of elements) {
    if (element === null) {
      defineDataProperty(array, String(nextIndex), undefined);
      nextIndex += 1;
      continue;
    }

    const elementNode = asNode(element);
    if (elementNode.type === "SpreadElement") {
      for (const value of await getSpreadValues(
        await evaluateExpression(getNode(elementNode, "argument"), context),
        context,
      )) {
        defineDataProperty(array, String(nextIndex), value);
        nextIndex += 1;
      }
      continue;
    }

    defineDataProperty(array, String(nextIndex), await evaluateExpression(elementNode, context));
    nextIndex += 1;
  }

  return array;
}

async function evaluateObjectExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<VMObject> {
  const object = createGuestObject(context);

  for (const property of getNodeArray(expression, "properties")) {
    if (property.type === "SpreadElement") {
      const spreadValue = asGuestObject(
        await evaluateExpression(getNode(property, "argument"), context),
      );
      for (const key of await getEnumerableOwnStringKeys(spreadValue, context)) {
        defineDataProperty(object, key, await getGuestProperty(spreadValue, key, context));
      }
      continue;
    }

    if (property.type !== "Property") {
      throw unsupportedNode(
        property,
        "Only plain object properties and object spread are supported.",
      );
    }

    const key = await propertyKeyFromProperty(property, context);

    if (property.kind === "get" || property.kind === "set") {
      const accessor = createUserFunction(
        getNode(property, "value"),
        context,
        propertyKeyToFunctionName(key),
        { constructable: false },
      );
      const descriptor =
        property.kind === "get"
          ? { configurable: true, enumerable: true, get: accessor, kind: "accessor" as const }
          : { configurable: true, enumerable: true, kind: "accessor" as const, set: accessor };

      if (!defineOwnProperty(object, key, descriptor)) {
        throw runtimeError("Unable to define VM object accessor.", {
          path: propertyKeyToString(key),
          reason: "accessor definition failed",
        });
      }
      continue;
    }

    if (property.kind !== "init") {
      throw unsupportedNode(property, "Unsupported object property kind.");
    }

    const value =
      property.method === true
        ? createUserFunction(getNode(property, "value"), context, propertyKeyToFunctionName(key), {
            constructable: false,
          })
        : await evaluateExpression(getNode(property, "value"), context);
    defineDataProperty(object, key, value);
  }

  return object;
}

async function evaluateClass(
  node: ASTNode,
  context: VMExecutionContext,
  options: VMClassEvaluationOptions = {},
): Promise<VMUserFunction> {
  const superNode = node.superClass;
  const superClass =
    superNode === null || superNode === undefined
      ? undefined
      : await evaluateClassHeritage(asNode(superNode), context);
  const superPrototype =
    superClass === undefined ? null : await getClassPrototype(superClass, context);
  const className = options.nameHint ?? "";
  const classEnvironment = createClassNameEnvironment(node, context, className);
  const previousLexical = context.lexicalEnvironment;
  const previousVariable = context.variableEnvironment;

  context.lexicalEnvironment = classEnvironment ?? previousLexical;
  context.variableEnvironment = classEnvironment ?? previousVariable;

  try {
    const elements = getNodeArray(getNode(node, "body"), "body");
    const privateEnvironment = collectPrivateNames(elements);
    const constructorMethod = findConstructorMethod(elements);
    const prototype = createOrdinaryObject(
      superPrototype ?? getIntrinsics(context).objectPrototype,
    );
    const constructor = createOrdinaryObject(superClass ?? null) as VMUserFunction;
    const constructorParams =
      constructorMethod === undefined
        ? []
        : getNodeArray(getNode(constructorMethod, "value"), "params");
    const classInfo: VMClassInfo = {
      constructorMethod,
      environment: context.lexicalEnvironment,
      instanceElements: [],
      name: className,
      privateEnvironment,
      prototype,
      superClass,
    };

    defineUserFunctionProperty(constructor, "name", className, {
      configurable: true,
      writable: false,
    });
    defineUserFunctionProperty(constructor, "length", getFunctionLength(constructorParams), {
      configurable: true,
      writable: false,
    });
    defineUserFunctionProperty(prototype, "constructor", constructor, {
      configurable: true,
      writable: true,
    });
    defineUserFunctionProperty(constructor, "prototype", prototype, {
      configurable: false,
      writable: false,
    });

    userFunctionRecords.set(constructor, {
      async: false,
      body:
        constructorMethod === undefined
          ? createEmptyBlockStatement()
          : getNode(getNode(constructorMethod, "value"), "body"),
      classInfo,
      constructable: true,
      environment: context.lexicalEnvironment,
      expressionBody: false,
      homeObject: prototype,
      lexicalThis: context.thisValue,
      name: className,
      params: constructorParams,
      privateEnvironment,
      arrow: false,
    });

    const instanceElements = await defineClassElements(
      elements,
      context,
      constructor,
      prototype,
      privateEnvironment,
    );
    (classInfo as { instanceElements: readonly VMClassInstanceElement[] }).instanceElements =
      instanceElements;

    initializeClassNameBinding(classEnvironment, className, constructor);
    options.initializeName?.(constructor);

    await initializeStaticFields(elements, context, constructor, privateEnvironment);

    return constructor;
  } finally {
    context.lexicalEnvironment = previousLexical;
    context.variableEnvironment = previousVariable;
  }
}

async function evaluateClassHeritage(
  superNode: ASTNode,
  context: VMExecutionContext,
): Promise<VMUserFunction> {
  const superClass = await evaluateExpression(superNode, context);

  if (!isUserFunction(superClass)) {
    throw runtimeError("Class extends value must be a VM-owned constructor.", {
      reason: "invalid class heritage",
      valueType: guestTypeof(superClass),
    });
  }

  const superRecord = userFunctionRecords.get(superClass);
  if (superRecord === undefined || !superRecord.constructable) {
    throw runtimeError("Class extends value is not constructable.", {
      reason: "invalid class heritage",
      valueType: guestTypeof(superClass),
    });
  }

  return superClass;
}

async function getClassPrototype(
  superClass: VMUserFunction,
  context: VMExecutionContext,
): Promise<VMObject | null> {
  const prototype = await getGuestProperty(superClass, "prototype", context);
  if (prototype === null) {
    return null;
  }
  if (!isVMObject(prototype)) {
    throw runtimeError("Class extends constructor must expose a VM-owned prototype.", {
      reason: "invalid class prototype",
      valueType: guestTypeof(prototype),
    });
  }
  return prototype;
}

function createClassNameEnvironment(
  node: ASTNode,
  context: VMExecutionContext,
  className: string,
): VMEnvironment | undefined {
  if (node.type !== "ClassExpression" || className.length === 0) {
    return undefined;
  }

  const environment = createLexicalEnvironment(context.lexicalEnvironment);
  environment.define(className, {
    kind: "const",
    mutable: false,
    deletable: false,
    initialized: false,
  });
  return environment;
}

function initializeClassNameBinding(
  environment: VMEnvironment | undefined,
  className: string,
  constructor: VMUserFunction,
): void {
  if (environment !== undefined && className.length > 0) {
    environment.initialize(className, constructor);
  }
}

function collectPrivateNames(elements: readonly ASTNode[]): ReadonlyMap<string, VMPrivateName> {
  const privateEnvironment = new Map<string, VMPrivateName>();

  for (const element of elements) {
    const key = getNode(element, "key");
    if (key.type !== "PrivateIdentifier") {
      continue;
    }

    const name = getString(key, "name");
    if (!privateEnvironment.has(name)) {
      privateEnvironment.set(name, Object.freeze({ description: name }));
    }
  }

  return privateEnvironment;
}

function findConstructorMethod(elements: readonly ASTNode[]): ASTNode | undefined {
  let constructorMethod: ASTNode | undefined;

  for (const element of elements) {
    if (
      element.type !== "MethodDefinition" ||
      element.static === true ||
      getString(element, "kind") !== "constructor"
    ) {
      continue;
    }

    if (constructorMethod !== undefined) {
      throw syntaxError("Classes cannot contain multiple constructors.", {
        reason: "duplicate constructor",
      });
    }
    constructorMethod = element;
  }

  return constructorMethod;
}

async function defineClassElements(
  elements: readonly ASTNode[],
  context: VMExecutionContext,
  constructor: VMUserFunction,
  prototype: VMObject,
  privateEnvironment: ReadonlyMap<string, VMPrivateName>,
): Promise<readonly VMClassInstanceElement[]> {
  const instanceElements: VMClassInstanceElement[] = [];

  for (const element of elements) {
    if (element.type === "MethodDefinition") {
      if (getString(element, "kind") === "constructor") {
        continue;
      }

      const isStatic = element.static === true;
      const homeObject = isStatic ? constructor : prototype;
      const target = homeObject;
      const key = await classElementKey(element, context, privateEnvironment);
      const method = createUserFunction(
        getNode(element, "value"),
        context,
        propertyKeyToFunctionName(key.label),
        { constructable: false, homeObject, privateEnvironment },
      );

      if (key.privateName !== undefined) {
        const entry = privateMethodEntry(element, method);
        if (isStatic) {
          definePrivateSlot(constructor, key.privateName, entry);
        } else {
          instanceElements.push({ entry, kind: "private", name: key.privateName });
        }
        continue;
      }

      defineClassMethod(target, key.label, getString(element, "kind"), method);
      continue;
    }

    if (element.type === "PropertyDefinition" || element.type === "FieldDefinition") {
      const key = await classElementKey(element, context, privateEnvironment);
      if (element.static === true) {
        continue;
      }

      if (key.privateName !== undefined) {
        instanceElements.push({
          entry: {
            kind: "field-initializer",
            value:
              element.value === null || element.value === undefined
                ? undefined
                : asNode(element.value),
          },
          kind: "private",
          name: key.privateName,
        });
      } else {
        instanceElements.push({
          key: key.label,
          kind: "field",
          value:
            element.value === null || element.value === undefined
              ? undefined
              : asNode(element.value),
        });
      }
      continue;
    }

    throw unsupportedNode(element, "Unsupported class element.");
  }

  return Object.freeze(instanceElements);
}

async function initializeStaticFields(
  elements: readonly ASTNode[],
  context: VMExecutionContext,
  constructor: VMUserFunction,
  privateEnvironment: ReadonlyMap<string, VMPrivateName>,
): Promise<void> {
  for (const element of elements) {
    if (
      element.static !== true ||
      (element.type !== "PropertyDefinition" && element.type !== "FieldDefinition")
    ) {
      continue;
    }

    const key = await classElementKey(element, context, privateEnvironment);
    const valueNode =
      element.value === null || element.value === undefined ? undefined : asNode(element.value);
    const value =
      valueNode === undefined
        ? undefined
        : await evaluateWithFrame(
            context,
            { homeObject: constructor, privateEnvironment },
            async () => {
              const previousThis = context.thisValue;
              context.thisValue = constructor;
              try {
                return await evaluateExpression(valueNode, context);
              } finally {
                context.thisValue = previousThis;
              }
            },
          );

    if (key.privateName !== undefined) {
      definePrivateSlot(constructor, key.privateName, { kind: "field", value });
    } else {
      defineDataProperty(constructor, key.label, value);
    }
  }
}

async function classElementKey(
  element: ASTNode,
  context: VMExecutionContext,
  privateEnvironment: ReadonlyMap<string, VMPrivateName>,
): Promise<{ readonly label: VMPropertyKey; readonly privateName?: VMPrivateName }> {
  const key = getNode(element, "key");
  if (key.type === "PrivateIdentifier") {
    const name = getString(key, "name");
    const privateName = privateEnvironment.get(name);
    if (privateName === undefined) {
      throw runtimeError(`Unknown private name #${name}.`, {
        reason: "unknown private name",
        path: name,
      });
    }
    return { label: `#${name}`, privateName };
  }

  if (element.computed === true) {
    return { label: await toPropertyKey(await evaluateExpression(key, context), context) };
  }

  if (key.type === "Identifier") {
    return { label: getString(key, "name") };
  }

  if (key.type === "Literal") {
    return { label: await toPropertyKey(key.value, context) };
  }

  throw unsupportedNode(key, "Unsupported class element key.");
}

function privateMethodEntry(element: ASTNode, method: VMUserFunction): VMPrivateEntry {
  switch (getString(element, "kind")) {
    case "method":
      return { kind: "method", value: method };
    case "get":
      return { get: method, kind: "accessor" };
    case "set":
      return { kind: "accessor", set: method };
    default:
      throw unsupportedNode(element, "Unsupported private class method kind.");
  }
}

function defineClassMethod(
  target: VMObject,
  key: VMPropertyKey,
  kind: string,
  method: VMUserFunction,
): void {
  if (kind === "method") {
    defineClassDataProperty(target, key, method);
    return;
  }

  if (kind === "get" || kind === "set") {
    const existing = getOwnPropertyDescriptor(target, key);
    const descriptor =
      kind === "get"
        ? {
            configurable: true,
            enumerable: false,
            get: method,
            kind: "accessor" as const,
            set: existing?.kind === "accessor" ? existing.set : undefined,
          }
        : {
            configurable: true,
            enumerable: false,
            get: existing?.kind === "accessor" ? existing.get : undefined,
            kind: "accessor" as const,
            set: method,
          };

    if (!defineOwnProperty(target, key, descriptor)) {
      throw runtimeError("Unable to define VM class accessor.", {
        path: propertyKeyToString(key),
        reason: "accessor definition failed",
      });
    }
    return;
  }

  throw runtimeError(`Unsupported class method kind ${kind}.`, {
    reason: "unsupported class method",
  });
}

function defineClassDataProperty(
  object: VMObject,
  key: VMPropertyKey,
  value: VMInternalValue,
): void {
  const defined = defineOwnProperty(object, key, {
    configurable: true,
    enumerable: false,
    kind: "data",
    value,
    writable: true,
  });

  if (!defined) {
    throw runtimeError("Unable to define VM class method.", {
      path: propertyKeyToString(key),
      reason: "property definition failed",
    });
  }
}

function createEmptyBlockStatement(): ASTNode {
  return { body: [], type: "BlockStatement" };
}

function isPatternNode(node: ASTNode): boolean {
  return node.type === "ArrayPattern" || node.type === "ObjectPattern";
}

async function evaluateAssignmentExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<VMInternalValue> {
  const leftNode = getNode(expression, "left");
  const operator = getString(expression, "operator");

  if (isPatternNode(leftNode)) {
    if (operator !== "=") {
      throw unsupportedNode(leftNode, "Destructuring assignments only support the = operator.");
    }
    const value = await evaluateExpression(getNode(expression, "right"), context);
    await assignPattern(leftNode, value, context);
    return value;
  }

  const reference = await evaluateReference(leftNode, context);

  if (operator === "=") {
    return await reference.set(await evaluateExpression(getNode(expression, "right"), context));
  }

  const left = await reference.get();
  const right = await evaluateExpression(getNode(expression, "right"), context);
  const value = await applyAssignmentOperator(operator, left, right, context);
  return await reference.set(value);
}

async function evaluateUpdateExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<VMInternalValue> {
  const reference = await evaluateReference(getNode(expression, "argument"), context);
  const oldValue = await toNumeric(await reference.get(), context);
  const operator = getString(expression, "operator");
  const nextValue =
    typeof oldValue === "bigint"
      ? operator === "++"
        ? oldValue + 1n
        : oldValue - 1n
      : operator === "++"
        ? oldValue + 1
        : oldValue - 1;
  await reference.set(nextValue);
  return expression.prefix === true ? nextValue : oldValue;
}

async function evaluateBinaryExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<VMInternalValue> {
  const left = await evaluateExpression(getNode(expression, "left"), context);
  const right = await evaluateExpression(getNode(expression, "right"), context);

  switch (getString(expression, "operator")) {
    case "+": {
      const leftPrimitive = await toPrimitive(left, context, "default");
      const rightPrimitive = await toPrimitive(right, context, "default");
      if (typeof leftPrimitive === "string" || typeof rightPrimitive === "string") {
        return (
          toStringFromPrimitive(leftPrimitive, context) +
          toStringFromPrimitive(rightPrimitive, context)
        );
      }
      const leftNumeric = toNumericFromPrimitive(leftPrimitive, context);
      const rightNumeric = toNumericFromPrimitive(rightPrimitive, context);
      if (typeof leftNumeric !== typeof rightNumeric) {
        throwGuestError(context, "TypeError", "Cannot mix BigInt and other numeric types.");
      }
      return typeof leftNumeric === "bigint"
        ? leftNumeric + (rightNumeric as bigint)
        : leftNumeric + (rightNumeric as number);
    }
    case "-":
      return applyNumericBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        "-",
        context,
      );
    case "*":
      return applyNumericBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        "*",
        context,
      );
    case "/":
      return applyNumericBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        "/",
        context,
      );
    case "%":
      return applyNumericBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        "%",
        context,
      );
    case "**":
      return applyNumericBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        "**",
        context,
      );
    case "<":
      return (await compareLessThan(left, right, context)) ?? false;
    case "<=": {
      const comparison = await compareLessThan(right, left, context);
      return comparison === undefined ? false : !comparison;
    }
    case ">":
      return (await compareLessThan(right, left, context)) ?? false;
    case ">=": {
      const comparison = await compareLessThan(left, right, context);
      return comparison === undefined ? false : !comparison;
    }
    case "==":
      return left == right;
    case "!=":
      return left != right;
    case "===":
      return left === right;
    case "!==":
      return left !== right;
    case "|":
      return applyBitwiseBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        "|",
        context,
      );
    case "&":
      return applyBitwiseBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        "&",
        context,
      );
    case "^":
      return applyBitwiseBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        "^",
        context,
      );
    case "<<":
      return applyBitwiseBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        "<<",
        context,
      );
    case ">>":
      return applyBitwiseBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        ">>",
        context,
      );
    case ">>>":
      return applyBitwiseBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        ">>>",
        context,
      );
    case "in":
      return hasGuestProperty(right, await toPropertyKey(left, context), context);
    case "instanceof":
      return instanceOfGuest(left, right, context);
    default:
      throw unsupportedNode(
        expression,
        `Unsupported binary operator ${getString(expression, "operator")}.`,
      );
  }
}

async function evaluateLogicalExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<VMInternalValue> {
  const left = await evaluateExpression(getNode(expression, "left"), context);
  const operator = getString(expression, "operator");

  if (operator === "&&") {
    return isTruthy(left) ? evaluateExpression(getNode(expression, "right"), context) : left;
  }

  if (operator === "||") {
    return isTruthy(left) ? left : evaluateExpression(getNode(expression, "right"), context);
  }

  if (operator === "??") {
    return left === null || left === undefined
      ? evaluateExpression(getNode(expression, "right"), context)
      : left;
  }

  throw unsupportedNode(expression, `Unsupported logical operator ${operator}.`);
}

async function evaluateUnaryExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<VMInternalValue> {
  const operator = getString(expression, "operator");

  if (operator === "typeof") {
    const argument = getNode(expression, "argument");
    if (
      argument.type === "Identifier" &&
      !context.lexicalEnvironment.has(getString(argument, "name"))
    ) {
      return "undefined";
    }
    return guestTypeof(await evaluateExpression(argument, context));
  }

  if (operator === "delete") {
    return await (await evaluateReference(getNode(expression, "argument"), context)).delete();
  }

  const value = await evaluateExpression(getNode(expression, "argument"), context);

  switch (operator) {
    case "!":
      return !isTruthy(value);
    case "+":
      return toNumber(value, context);
    case "-":
      return applyUnaryMinus(await toNumeric(value, context));
    case "~":
      return applyUnaryBitwiseNot(await toNumeric(value, context));
    case "void":
      return undefined;
    default:
      throw unsupportedNode(expression, `Unsupported unary operator ${operator}.`);
  }
}

async function evaluateCallExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<VMInternalValue> {
  const calleeNode = getNode(expression, "callee");

  if (calleeNode.type === "Super") {
    return evaluateSuperCallExpression(expression, context);
  }

  const calleeReference =
    calleeNode.type === "MemberExpression"
      ? await evaluateReference(calleeNode, context)
      : undefined;
  const callee =
    calleeReference === undefined
      ? await evaluateExpression(calleeNode, context)
      : await calleeReference.get();
  const thisValue =
    calleeReference?.kind === "member" || calleeReference?.kind === "private-member"
      ? calleeReference.object
      : undefined;
  const userThisValue = thisValue ?? context.globalObject;
  const args = await evaluateArgumentList(getNodeArray(expression, "arguments"), context);

  if (
    calleeNode.type === "Identifier" &&
    getString(calleeNode, "name") === "eval" &&
    isDynamicCodeEvaluator(callee)
  ) {
    return evaluateDynamicSourceArgument(args[0], context, true);
  }

  return invokeCallableValue(callee, args, context, thisValue, userThisValue);
}

async function evaluateSuperCallExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<VMInternalValue> {
  const frame = currentFrame(context);
  const construction = frame?.construction;
  const superClass = construction?.classInfo.superClass;

  if (construction === undefined || superClass === undefined) {
    throw runtimeError("super() is only supported inside derived class constructors.", {
      reason: "invalid super call",
    });
  }

  if (construction.superInitialized) {
    throw runtimeError("super() has already been called for this derived constructor.", {
      reason: "duplicate super call",
    });
  }

  const args = await evaluateArgumentList(getNodeArray(expression, "arguments"), context);
  const superResult = await constructUserFunction(superClass, args, context, construction.instance);
  construction.instance = isVMObject(superResult) ? superResult : construction.instance;
  construction.superInitialized = true;

  const previousThis = context.thisValue;
  context.thisValue = construction.instance;
  try {
    await initializeClassInstanceElements(construction.classInfo, construction.instance, context);
    construction.derivedElementsInitialized = true;
  } finally {
    context.thisValue = construction.instance;
    void previousThis;
  }

  return construction.instance;
}

async function invokeCallableValue(
  callee: VMInternalValue,
  args: readonly VMInternalValue[],
  context: VMExecutionContext,
  thisValue: VMInternalValue | undefined,
  userThisValue: VMInternalValue = thisValue ?? context.globalObject,
): Promise<VMInternalValue> {
  if (isHostCallable(callee)) {
    const hostArgs = await exportGuestArguments(args, context);

    return importGuestValue(
      await invokeHostCallable(callee, hostArgs),
      "<capability-result>",
      getIntrinsics(context),
    );
  }

  if (isNativeCallable(callee)) {
    return importGuestValue(
      await invokeNativeCallable(callee, args, context, thisValue, createNativeTools(context)),
      `<${callee.metadata.name}-result>`,
      getIntrinsics(context),
    );
  }

  if (isProxyObject(callee)) {
    return proxyApply(callee, args, context, thisValue, userThisValue);
  }

  if (isNativeFunctionObject(callee)) {
    const record = nativeFunctionRecords.get(callee);
    return importGuestValue(
      await record!.call(args, context, thisValue),
      `<${getNativeFunctionName(callee)}-result>`,
      getIntrinsics(context),
    );
  }

  if (isUserFunction(callee)) {
    return invokeUserFunction(callee, args, context, userThisValue);
  }

  throwGuestError(context, "TypeError", "Value is not callable in the VM.");
}

async function evaluateChainExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<VMInternalValue> {
  return (await evaluateChainNode(getNode(expression, "expression"), context)).value;
}

async function evaluateChainNode(
  node: ASTNode,
  context: VMExecutionContext,
): Promise<ChainEvaluation> {
  if (node.type === "ChainExpression") {
    return evaluateChainNode(getNode(node, "expression"), context);
  }

  if (node.type === "MemberExpression") {
    return evaluateChainMemberExpression(node, context);
  }

  if (node.type === "CallExpression") {
    return evaluateChainCallExpression(node, context);
  }

  return { shortCircuited: false, value: await evaluateExpression(node, context) };
}

async function evaluateChainMemberExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<ChainEvaluation> {
  const objectResult = await evaluateChainNode(getNode(expression, "object"), context);
  if (objectResult.shortCircuited) {
    return objectResult;
  }

  const objectValue = objectResult.value;
  if (expression.optional === true && isNullish(objectValue)) {
    return chainShortCircuit();
  }

  const object = asGuestObject(objectValue);
  const property = getNode(expression, "property");
  if (property.type === "PrivateIdentifier") {
    const reference = createPrivateMemberReference(object, getString(property, "name"), context);
    return { reference, shortCircuited: false, value: await reference.get() };
  }

  const key = await propertyKeyFromMember(expression, context);
  const reference = createMemberReferenceFromObject(object, key, context);
  return { reference, shortCircuited: false, value: await reference.get() };
}

async function evaluateChainCallExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<ChainEvaluation> {
  const calleeResult = await evaluateChainNode(getNode(expression, "callee"), context);
  if (calleeResult.shortCircuited) {
    return calleeResult;
  }

  const callee = calleeResult.value;
  if (expression.optional === true && isNullish(callee)) {
    return chainShortCircuit();
  }

  const thisValue =
    calleeResult.reference?.kind === "member" || calleeResult.reference?.kind === "private-member"
      ? calleeResult.reference.object
      : undefined;
  const userThisValue = thisValue ?? context.globalObject;
  const args = await evaluateArgumentList(getNodeArray(expression, "arguments"), context);
  return {
    shortCircuited: false,
    value: await invokeCallableValue(callee, args, context, thisValue, userThisValue),
  };
}

function chainShortCircuit(): ChainEvaluation {
  return { shortCircuited: true, value: undefined };
}

async function evaluateNewExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<VMInternalValue> {
  const callee = await evaluateExpression(getNode(expression, "callee"), context);
  const args = await evaluateArgumentList(getNodeArray(expression, "arguments"), context);
  return constructValue(callee, args, context, expression);
}

async function constructValue(
  callee: VMInternalValue,
  args: readonly VMInternalValue[],
  context: VMExecutionContext,
  sourceNode?: ASTNode,
): Promise<VMInternalValue> {
  if (isProxyObject(callee)) {
    return proxyConstruct(callee, args, context);
  }

  if (isNativeCallable(callee) && callee.constructable) {
    return importGuestValue(
      await constructNativeCallable(callee, args, context, createNativeTools(context)),
      `<${callee.metadata.name}-instance>`,
      getIntrinsics(context),
    );
  }

  if (isNativeFunctionObject(callee)) {
    const record = nativeFunctionRecords.get(callee);
    if (record?.construct !== undefined) {
      return importGuestValue(
        await record.construct(args, context, undefined),
        `<${getNativeFunctionName(callee)}-instance>`,
        getIntrinsics(context),
      );
    }
  }

  if (isUserFunction(callee)) {
    return constructUserFunction(callee, args, context);
  }

  void sourceNode;
  throwGuestError(context, "TypeError", "Value is not constructable in the VM.");
}

async function evaluateTemplateLiteral(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<string> {
  const quasis = getNodeArray(expression, "quasis");
  const expressions = getNodeArray(expression, "expressions");
  let output = "";

  for (let index = 0; index < quasis.length; index += 1) {
    const value = asRecord(quasis[index].value, "template value");
    const cooked = value.cooked;
    if (typeof cooked !== "string") {
      throw unsupportedNode(
        expression,
        "Template literals with invalid escapes are not supported.",
      );
    }
    output += cooked;

    if (index < expressions.length) {
      output += String(await evaluateExpression(expressions[index], context));
    }
  }

  return output;
}

async function evaluateArgumentList(
  argumentsList: readonly ASTNode[],
  context: VMExecutionContext,
): Promise<VMInternalValue[]> {
  const args = [] as VMInternalValue[];

  for (const argument of argumentsList) {
    if (argument.type === "SpreadElement") {
      args.push(
        ...(await getSpreadValues(
          await evaluateExpression(getNode(argument, "argument"), context),
          context,
        )),
      );
      continue;
    }
    args.push(await evaluateExpression(argument, context));
  }

  return args;
}

async function evaluateReference(node: ASTNode, context: VMExecutionContext): Promise<Reference> {
  if (node.type === "Identifier") {
    return createBindingReference(getString(node, "name"), context);
  }

  if (node.type === "MemberExpression") {
    return createMemberReference(node, context);
  }

  throw unsupportedNode(
    node,
    "Only identifiers and member expressions can be assigned or deleted.",
  );
}

function createBindingReference(name: string, context: VMExecutionContext): BindingReference {
  assertSafeBindingName(name);

  return {
    kind: "binding",
    name,
    get() {
      return context.lexicalEnvironment.get(name);
    },
    set(value) {
      const resolved = context.lexicalEnvironment.resolve(name);

      if (resolved === undefined) {
        context.globalEnvironment.define(name, {
          kind: "var",
          mutable: true,
          deletable: true,
          initialized: true,
          value,
        });
        defineGlobalObjectProperty(context.globalObject, name, value);
      } else {
        resolved.environment.set(name, value);
        if (resolved.environment === context.globalEnvironment) {
          setGlobalObjectProperty(context.globalObject, name, value);
        }
      }
      return value;
    },
    delete() {
      return context.lexicalEnvironment.delete(name);
    },
  };
}

async function createMemberReference(
  node: ASTNode,
  context: VMExecutionContext,
): Promise<MemberReference | PrivateMemberReference> {
  const objectNode = getNode(node, "object");
  if (objectNode.type === "Super") {
    return createSuperMemberReference(node, context);
  }

  const object = await evaluateExpression(objectNode, context);
  const property = getNode(node, "property");
  if (property.type === "PrivateIdentifier") {
    return createPrivateMemberReference(
      asGuestObject(object),
      getString(property, "name"),
      context,
    );
  }
  const key = await propertyKeyFromMember(node, context);

  return createMemberReferenceFromObject(object, key, context);
}

async function createSuperMemberReference(
  node: ASTNode,
  context: VMExecutionContext,
): Promise<MemberReference> {
  const receiver = asGuestObject(getThisValue(context));
  const base = getSuperBase(context);
  const key = await propertyKeyFromMember(node, context);

  return {
    kind: "member",
    object: receiver,
    key,
    async get() {
      return base === null ? undefined : getGuestProperty(base, key, context, receiver);
    },
    async set(value) {
      if (base !== null) {
        await setGuestProperty(base, key, value, context, receiver);
      }
      return value;
    },
    delete() {
      return false;
    },
  };
}

function createMemberReferenceFromObject(
  object: VMInternalValue,
  key: VMPropertyKey,
  context: VMExecutionContext,
): MemberReference {
  return {
    kind: "member",
    object,
    key,
    async get() {
      return getGuestProperty(object, key, context);
    },
    async set(value) {
      await setGuestProperty(object, key, value, context);
      return value;
    },
    async delete() {
      return isVMObject(object) ? deleteGuestProperty(object, key, context) : true;
    },
  };
}

function createPrivateMemberReference(
  object: VMObject,
  name: string,
  context: VMExecutionContext,
): PrivateMemberReference {
  const privateName = resolvePrivateName(name, context);

  return {
    kind: "private-member",
    object,
    key: name,
    async get() {
      const entry = getPrivateSlot(object, privateName);
      if (entry.kind === "field") {
        return entry.value;
      }
      if (entry.kind === "method") {
        return entry.value;
      }
      if (entry.get === undefined) {
        return undefined;
      }
      return invokeCallableValue(entry.get, [], context, object, object);
    },
    async set(value) {
      const entry = getPrivateSlot(object, privateName);
      if (entry.kind === "field") {
        entry.value = value;
        return value;
      }
      if (entry.kind === "accessor" && entry.set !== undefined) {
        await invokeCallableValue(entry.set, [value], context, object, object);
        return value;
      }
      throw runtimeError(`Cannot assign to private method #${name}.`, {
        reason: "private assignment",
        path: name,
      });
    },
    delete() {
      return false;
    },
  };
}

async function getGuestProperty(
  object: VMInternalValue,
  key: VMPropertyKey,
  context: VMExecutionContext,
  receiver: VMInternalValue = object,
): Promise<VMInternalValue> {
  context.checkpoint(1, `get ${propertyKeyToString(key)}`);
  if (isProxyObject(object)) {
    return proxyGet(object, key, context, receiver);
  }

  const descriptor = await getPropertyDescriptorForValue(object, key, context);

  if (descriptor === undefined) {
    return undefined;
  }

  if (descriptor.kind === "data") {
    return descriptor.value;
  }

  if (descriptor.get === null) {
    return undefined;
  }

  return invokeCallableValue(descriptor.get, [], context, receiver, receiver);
}

async function setGuestProperty(
  object: VMInternalValue,
  key: VMPropertyKey,
  value: VMInternalValue,
  context: VMExecutionContext,
  receiver: VMInternalValue = object,
): Promise<boolean> {
  if (isProxyObject(object)) {
    return proxySet(object, key, value, context, receiver);
  }

  if (!isVMObject(object) || !isVMObject(receiver)) {
    return false;
  }

  if (isArrayLikeObject(receiver) && key !== "length" && !isArrayIndex(key)) {
    throw securityError("Arrays cannot carry custom properties in the VM.", {
      reason: "array custom property",
      path: propertyKeyToString(key),
    });
  }

  const descriptor = await getPropertyDescriptor(object, key, context);

  if (descriptor?.kind === "accessor") {
    if (descriptor.set !== null) {
      await invokeCallableValue(descriptor.set, [value], context, receiver, receiver);
      return true;
    }
    return false;
  }

  if (descriptor?.kind === "data" && !descriptor.writable) {
    return false;
  }

  if (isProxyObject(receiver)) {
    return definePropertyGuest(
      receiver,
      key,
      { configurable: true, enumerable: true, kind: "data", value, writable: true },
      context,
    );
  }

  const receiverDescriptor = await getOwnPropertyDescriptorGuest(receiver, key, context);
  if (receiverDescriptor !== undefined) {
    if (receiverDescriptor.kind === "accessor" || !receiverDescriptor.writable) {
      return false;
    }
    return definePropertyGuest(receiver, key, { kind: "data", value }, context);
  }

  return definePropertyGuest(
    receiver,
    key,
    { configurable: true, enumerable: true, kind: "data", value, writable: true },
    context,
  );
}

async function getPropertyDescriptor(
  object: VMObject,
  key: VMPropertyKey,
  context: VMExecutionContext,
): Promise<ReturnType<typeof getOwnPropertyDescriptor>> {
  let current: VMObject | null = object;

  while (current !== null) {
    const descriptor = await getOwnPropertyDescriptorGuest(current, key, context);
    if (descriptor !== undefined) {
      return descriptor;
    }

    current = await getPrototypeOfGuest(current, context);
  }

  return undefined;
}

async function getPropertyDescriptorForValue(
  value: VMInternalValue,
  key: VMPropertyKey,
  context: VMExecutionContext,
): Promise<ReturnType<typeof getOwnPropertyDescriptor>> {
  if (isVMObject(value)) {
    return getPropertyDescriptor(value, key, context);
  }

  const callableDescriptor = getOwnCallablePropertyDescriptor(value, key);
  if (callableDescriptor !== undefined) {
    return callableDescriptor;
  }

  const intrinsics = getIntrinsics(context);
  if (typeof value === "string") {
    if (key === "length") {
      return {
        configurable: false,
        enumerable: false,
        kind: "data",
        value: value.length,
        writable: false,
      };
    }
    return getPropertyDescriptor(intrinsics.stringPrototype, key, context);
  }
  if (typeof value === "number") {
    return getPropertyDescriptor(intrinsics.numberPrototype, key, context);
  }
  if (typeof value === "boolean") {
    return getPropertyDescriptor(intrinsics.booleanPrototype, key, context);
  }
  if (typeof value === "bigint") {
    return getPropertyDescriptor(intrinsics.objectPrototype, key, context);
  }

  if (value === null || value === undefined) {
    throwGuestError(context, "TypeError", "Cannot read properties of null or undefined.");
  }

  return undefined;
}

async function instanceOfGuest(
  value: VMInternalValue,
  constructor: VMInternalValue,
  context: VMExecutionContext,
): Promise<boolean> {
  if (!isCallableValue(constructor)) {
    throwGuestError(context, "TypeError", "Right-hand side of instanceof is not callable.");
  }

  if (!isVMObject(value)) {
    return false;
  }

  const prototype = await getGuestProperty(constructor, "prototype", context);
  if (!isVMObject(prototype)) {
    throwGuestError(context, "TypeError", "Constructor prototype must be a VM object.");
  }

  let current = await getPrototypeOfGuest(value, context);
  while (current !== null) {
    if (current === prototype) {
      return true;
    }
    current = await getPrototypeOfGuest(current, context);
  }
  return false;
}

async function deleteGuestProperty(
  object: VMObject,
  key: VMPropertyKey,
  context: VMExecutionContext,
): Promise<boolean> {
  if (isProxyObject(object)) {
    return proxyDeleteProperty(object, key, context);
  }
  return deleteObjectProperty(object, key);
}

async function assignLoopLeft(
  left: ASTNode,
  value: VMInternalValue,
  context: VMExecutionContext,
): Promise<void> {
  if (left.type === "VariableDeclaration") {
    const declarations = getNodeArray(left, "declarations");
    if (declarations.length !== 1) {
      throw unsupportedNode(left, "Loop declarations must contain exactly one binding.");
    }

    const id = getNode(declarations[0], "id");
    await bindPattern(id, value, context, {
      environment: context.lexicalEnvironment,
      kind: getString(left, "kind") as "var" | "let" | "const",
      mutable: true,
      reuseExisting: true,
    });
    return;
  }

  if (isPatternNode(left)) {
    await assignPattern(left, value, context);
    return;
  }

  (await evaluateReference(left, context)).set(value);
}

async function bindPattern(
  pattern: ASTNode,
  value: VMInternalValue,
  context: VMExecutionContext,
  target: PatternBindingTarget,
): Promise<void> {
  await applyPattern(pattern, value, context, async (targetNode, nextValue) => {
    if (targetNode.type !== "Identifier") {
      throw unsupportedNode(targetNode, "Binding patterns can only bind identifiers.");
    }
    definePatternBinding(getString(targetNode, "name"), nextValue, context, target);
  });
}

async function assignPattern(
  pattern: ASTNode,
  value: VMInternalValue,
  context: VMExecutionContext,
): Promise<void> {
  await applyPattern(pattern, value, context, async (targetNode, nextValue) => {
    (await evaluateReference(targetNode, context)).set(nextValue);
  });
}

async function applyPattern(
  pattern: ASTNode,
  value: VMInternalValue,
  context: VMExecutionContext,
  write: (targetNode: ASTNode, value: VMInternalValue) => Promise<void>,
): Promise<void> {
  switch (pattern.type) {
    case "Identifier":
    case "MemberExpression":
      await write(pattern, value);
      return;
    case "AssignmentPattern": {
      const nextValue =
        value === undefined ? await evaluateExpression(getNode(pattern, "right"), context) : value;
      await applyPattern(getNode(pattern, "left"), nextValue, context, write);
      return;
    }
    case "RestElement":
      await applyPattern(getNode(pattern, "argument"), value, context, write);
      return;
    case "ArrayPattern":
      await applyArrayPattern(pattern, value, context, write);
      return;
    case "ObjectPattern":
      await applyObjectPattern(pattern, value, context, write);
      return;
    default:
      throw unsupportedNode(pattern, "Unsupported destructuring target.");
  }
}

async function applyArrayPattern(
  pattern: ASTNode,
  value: VMInternalValue,
  context: VMExecutionContext,
  write: (targetNode: ASTNode, value: VMInternalValue) => Promise<void>,
): Promise<void> {
  const values = await getForOfValues(value, context);
  const elements = getUnknownArray(pattern, "elements");
  let index = 0;

  for (const element of elements) {
    if (element === null) {
      index += 1;
      continue;
    }

    const elementNode = asNode(element);
    if (elementNode.type === "RestElement") {
      await applyPattern(
        getNode(elementNode, "argument"),
        createGuestArray(values.slice(index), context),
        context,
        write,
      );
      return;
    }

    await applyPattern(elementNode, values[index], context, write);
    index += 1;
  }
}

async function applyObjectPattern(
  pattern: ASTNode,
  value: VMInternalValue,
  context: VMExecutionContext,
  write: (targetNode: ASTNode, value: VMInternalValue) => Promise<void>,
): Promise<void> {
  const object = asGuestObject(value);
  const excludedKeys = new Set<VMPropertyKey>();

  for (const property of getNodeArray(pattern, "properties")) {
    if (property.type === "RestElement") {
      const rest = createGuestObject(context);
      for (const key of await getEnumerableOwnStringKeys(object, context)) {
        if (!excludedKeys.has(key)) {
          defineDataProperty(rest, key, await getGuestProperty(object, key, context));
        }
      }
      await applyPattern(getNode(property, "argument"), rest, context, write);
      continue;
    }

    if (property.type !== "Property" || property.kind !== "init") {
      throw unsupportedNode(property, "Only plain object destructuring properties are supported.");
    }

    const key = await propertyKeyFromProperty(property, context);
    excludedKeys.add(key);
    await applyPattern(
      getNode(property, "value"),
      await getGuestProperty(object, key, context),
      context,
      write,
    );
  }
}

function definePatternBinding(
  name: string,
  value: VMInternalValue,
  context: VMExecutionContext,
  target: PatternBindingTarget,
): void {
  assertSafeBindingName(name);

  if (target.kind === "var") {
    if (!target.environment.hasOwn(name)) {
      target.environment.define(name, {
        kind: "var",
        mutable: true,
        deletable: true,
        initialized: true,
      });
      if (target.environment === context.globalEnvironment) {
        defineGlobalObjectProperty(context.globalObject, name, undefined);
      }
    }
    target.environment.set(name, value);
    if (target.environment === context.globalEnvironment) {
      setGlobalObjectProperty(context.globalObject, name, value);
    }
    return;
  }

  if (target.reuseExisting === true && target.environment.hasOwn(name)) {
    target.environment.set(name, value);
    return;
  }

  target.environment.define(name, {
    kind: target.kind,
    mutable: target.mutable ?? target.kind !== "const",
    deletable: false,
    initialized: true,
    value,
  });
}

async function getForOfValues(
  value: VMInternalValue,
  context: VMExecutionContext,
): Promise<VMInternalValue[]> {
  if (typeof value === "string") {
    return [...value];
  }

  const object = asGuestObject(value);
  if (isArrayLikeObject(object)) {
    return getArrayIndexValues(object, context);
  }

  throw runtimeError("for...of can only iterate VM arrays and strings.", {
    reason: "unsupported iterator",
    valueType: guestTypeof(value),
  });
}

async function getSpreadValues(
  value: VMInternalValue,
  context: VMExecutionContext,
): Promise<VMInternalValue[]> {
  if (typeof value === "string") {
    return [...value];
  }

  const object = asGuestObject(value);
  if (isArrayLikeObject(object)) {
    return getArrayIndexValues(object, context);
  }

  throw runtimeError("Spread can only expand VM arrays and strings.", {
    reason: "unsupported spread",
    valueType: guestTypeof(value),
  });
}

async function hasGuestProperty(
  value: VMInternalValue,
  key: VMPropertyKey,
  context: VMExecutionContext,
): Promise<boolean> {
  const object = asGuestObject(value);
  if (isProxyObject(object)) {
    return proxyHas(object, key, context);
  }
  let current: VMObject | null = object;
  while (current !== null) {
    if (isProxyObject(current)) {
      return proxyHas(current, key, context);
    }
    if (getOwnPropertyDescriptor(current, key) !== undefined) {
      return true;
    }
    current = await getPrototypeOfGuest(current, context);
  }
  return false;
}

async function getOwnPropertyDescriptorGuest(
  object: VMObject,
  key: VMPropertyKey,
  context: VMExecutionContext,
): Promise<VMPropertyDescriptor | undefined> {
  if (isProxyObject(object)) {
    return proxyGetOwnPropertyDescriptor(object, key, context);
  }
  return getOwnPropertyDescriptor(object, key);
}

async function definePropertyGuest(
  object: VMObject,
  key: VMPropertyKey,
  descriptor: VMPropertyDescriptorInput,
  context: VMExecutionContext,
): Promise<boolean> {
  if (isProxyObject(object)) {
    return proxyDefineProperty(object, key, descriptor, context);
  }
  return defineOwnProperty(object, key, descriptor);
}

async function ownKeysGuest(
  object: VMObject,
  context: VMExecutionContext,
): Promise<readonly VMPropertyKey[]> {
  if (isProxyObject(object)) {
    return proxyOwnKeys(object, context);
  }
  return ownKeys(object);
}

async function getPrototypeOfGuest(
  object: VMObject,
  context: VMExecutionContext,
): Promise<VMObject | null> {
  if (isProxyObject(object)) {
    return proxyGetPrototypeOf(object, context);
  }
  return getPrototypeOf(object);
}

async function setPrototypeOfGuest(
  object: VMObject,
  prototype: VMObject | null,
  context: VMExecutionContext,
): Promise<boolean> {
  if (isProxyObject(object)) {
    return proxySetPrototypeOf(object, prototype, context);
  }
  if (await wouldCreatePrototypeCycleGuest(object, prototype, context)) {
    return false;
  }
  return setObjectPrototype(object, prototype);
}

async function isExtensibleGuest(object: VMObject, context: VMExecutionContext): Promise<boolean> {
  if (isProxyObject(object)) {
    return proxyIsExtensible(object, context);
  }
  return isObjectExtensible(object);
}

async function preventExtensionsGuest(
  object: VMObject,
  context: VMExecutionContext,
): Promise<boolean> {
  if (isProxyObject(object)) {
    return proxyPreventExtensions(object, context);
  }
  return preventObjectExtensions(object);
}

async function wouldCreatePrototypeCycleGuest(
  object: VMObject,
  prototype: VMObject | null,
  context: VMExecutionContext,
): Promise<boolean> {
  const seen = new WeakSet<VMObject>();
  let current = prototype;
  while (current !== null) {
    if (current === object) {
      return true;
    }
    if (seen.has(current)) {
      return false;
    }
    seen.add(current);
    current = await getPrototypeOfGuest(current, context);
  }
  return false;
}

async function propertyKeyListFromTrapResult(
  value: VMInternalValue,
  context: VMExecutionContext,
): Promise<readonly VMPropertyKey[]> {
  const object = toObject(value, context);
  const lengthValue = await getGuestProperty(object, "length", context);
  const length = toArrayLength(lengthValue ?? 0);
  const keys: VMPropertyKey[] = [];

  for (let index = 0; index < length; index += 1) {
    keys.push(await toPropertyKey(await getGuestProperty(object, String(index), context), context));
  }

  return Object.freeze(keys);
}

async function arrayLikeArgumentList(
  value: VMInternalValue,
  context: VMExecutionContext,
): Promise<readonly VMInternalValue[]> {
  const object = toObject(value, context);
  const length = toArrayLength((await getGuestProperty(object, "length", context)) ?? 0);
  const args: VMInternalValue[] = [];
  for (let index = 0; index < length; index += 1) {
    args.push(await getGuestProperty(object, String(index), context));
  }
  return args;
}

function completePropertyDescriptor(descriptor: VMPropertyDescriptorInput): VMPropertyDescriptor {
  if (
    hasOwn.call(descriptor, "get") ||
    hasOwn.call(descriptor, "set") ||
    descriptor.kind === "accessor"
  ) {
    return Object.freeze({
      configurable: Boolean(descriptor.configurable),
      enumerable: Boolean(descriptor.enumerable),
      get: "get" in descriptor ? (descriptor.get ?? null) : null,
      kind: "accessor" as const,
      set: "set" in descriptor ? (descriptor.set ?? null) : null,
    });
  }

  return Object.freeze({
    configurable: Boolean(descriptor.configurable),
    enumerable: Boolean(descriptor.enumerable),
    kind: "data" as const,
    value: "value" in descriptor ? descriptor.value : undefined,
    writable: Boolean(descriptor.writable),
  });
}

function getOwnCallablePropertyDescriptor(
  value: VMInternalValue,
  key: VMPropertyKey,
): VMPropertyDescriptor | undefined {
  if (!isHostCallable(value) && !isNativeCallable(value)) {
    return undefined;
  }

  if (key === "name") {
    return {
      configurable: true,
      enumerable: false,
      kind: "data",
      value: value.metadata.name,
      writable: false,
    };
  }

  if (key === "length") {
    return {
      configurable: true,
      enumerable: false,
      kind: "data",
      value: value.metadata.arity ?? 0,
      writable: false,
    };
  }

  return undefined;
}

function validateProxyDescriptorReport(
  trapName: string,
  key: VMPropertyKey,
  descriptor: VMPropertyDescriptor,
  targetDescriptor: VMPropertyDescriptor | undefined,
  targetExtensible: boolean,
): void {
  if (targetDescriptor === undefined) {
    if (!targetExtensible) {
      throw proxyInvariantError(
        trapName,
        "cannot report a new property for a non-extensible target",
        key,
      );
    }
    if (!descriptor.configurable) {
      throw proxyInvariantError(trapName, "cannot report a new non-configurable property", key);
    }
    return;
  }

  if (!descriptor.configurable && targetDescriptor.configurable) {
    throw proxyInvariantError(
      trapName,
      "cannot report a configurable target property as non-configurable",
      key,
    );
  }

  if (
    !targetDescriptor.configurable &&
    !isDescriptorCompatibleWithFrozenTarget(descriptor, targetDescriptor)
  ) {
    throw proxyInvariantError(
      trapName,
      "reported descriptor is incompatible with a non-configurable target property",
      key,
    );
  }
}

function isDescriptorCompatibleWithFrozenTarget(
  descriptor: VMPropertyDescriptor,
  targetDescriptor: VMPropertyDescriptor,
): boolean {
  if (descriptor.configurable || descriptor.enumerable !== targetDescriptor.enumerable) {
    return false;
  }
  if (descriptor.kind !== targetDescriptor.kind) {
    return false;
  }
  if (targetDescriptor.kind === "data") {
    return (
      descriptor.kind === "data" &&
      (targetDescriptor.writable || !descriptor.writable) &&
      (targetDescriptor.writable || sameValueZero(descriptor.value, targetDescriptor.value))
    );
  }
  return (
    descriptor.kind === "accessor" &&
    descriptor.get === targetDescriptor.get &&
    descriptor.set === targetDescriptor.set
  );
}

function proxyInvariantError(trapName: string, message: string, key?: VMPropertyKey): VMError {
  return runtimeError(`Proxy ${trapName} invariant violation: ${message}.`, {
    path: key === undefined ? undefined : propertyKeyToString(key),
    reason: "proxy invariant",
  });
}

function defineDataProperty(object: VMObject, key: VMPropertyKey, value: VMInternalValue): void {
  const defined = defineOwnProperty(object, key, {
    configurable: true,
    enumerable: true,
    kind: "data",
    value,
    writable: true,
  });

  if (!defined) {
    throw runtimeError("Unable to define VM object property.", {
      path: propertyKeyToString(key),
      reason: "property definition failed",
    });
  }
}

function setGlobalObjectProperty(
  globalObject: VMObject,
  key: string,
  value: VMInternalValue,
): void {
  const set = setObjectProperty(globalObject, key, value);

  if (!set) {
    throw runtimeError("Unable to set VM global object property.", {
      path: key,
      reason: "property set failed",
    });
  }
}

async function getEnumerableOwnStringKeys(
  object: VMObject,
  context: VMExecutionContext,
): Promise<string[]> {
  const keys: string[] = [];

  for (const key of await ownKeysGuest(object, context)) {
    if (typeof key !== "string") {
      continue;
    }

    const descriptor = await getOwnPropertyDescriptorGuest(object, key, context);
    if (descriptor?.enumerable === true) {
      keys.push(key);
    }
  }

  return keys;
}

async function getArrayIndexValues(
  object: VMObject,
  context: VMExecutionContext,
): Promise<VMInternalValue[]> {
  const length = await getArrayLengthValue(object, context);
  const values: VMInternalValue[] = [];

  for (let index = 0; index < length; index += 1) {
    values.push(await getGuestProperty(object, String(index), context));
  }

  return values;
}

async function getArrayLengthValue(object: VMObject, context: VMExecutionContext): Promise<number> {
  const length = await getGuestProperty(object, "length", context);

  if (
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    length < 0 ||
    length > 2 ** 32 - 1
  ) {
    throw runtimeError("Invalid VM array length.", { reason: "invalid array length" });
  }

  return length;
}

async function propertyKeyFromMember(
  node: ASTNode,
  context: VMExecutionContext,
): Promise<VMPropertyKey> {
  if (node.computed === true) {
    return toPropertyKey(await evaluateExpression(getNode(node, "property"), context), context);
  }

  const property = getNode(node, "property");
  if (property.type !== "Identifier") {
    throw unsupportedNode(property, "Only identifier member properties are supported.");
  }
  return getString(property, "name");
}

async function propertyKeyFromProperty(
  node: ASTNode,
  context: VMExecutionContext,
): Promise<VMPropertyKey> {
  if (node.computed === true) {
    return toPropertyKey(await evaluateExpression(getNode(node, "key"), context), context);
  }

  const key = getNode(node, "key");
  if (key.type === "Identifier") {
    return getString(key, "name");
  }

  if (key.type === "Literal") {
    return toPropertyKey(key.value, context);
  }

  throw unsupportedNode(key, "Unsupported object property key.");
}

function hoistFunctionDeclarations(
  statements: readonly ASTNode[],
  context: VMExecutionContext,
  target: VMEnvironment,
): void {
  for (const statement of statements) {
    if (statement.type !== "FunctionDeclaration") {
      continue;
    }

    const name = getOptionalIdentifierName(statement, "id");
    if (name === undefined) {
      throw unsupportedNode(statement, "Function declarations must be named.");
    }

    const value = createUserFunction(statement, context, name);
    if (target.hasOwn(name)) {
      target.set(name, value);
      if (target === context.globalEnvironment) {
        setGlobalObjectProperty(context.globalObject, name, value);
      }
    } else {
      target.define(name, {
        kind: "var",
        mutable: true,
        deletable: true,
        initialized: true,
        value,
      });
      if (target === context.globalEnvironment) {
        defineGlobalObjectProperty(context.globalObject, name, value);
      }
    }
  }
}

function createUserFunction(
  node: ASTNode,
  context: VMExecutionContext,
  name: string | undefined,
  options: {
    readonly constructable?: boolean;
    readonly homeObject?: VMObject;
    readonly privateEnvironment?: ReadonlyMap<string, VMPrivateName>;
  } = {},
): VMUserFunction {
  const params = getNodeArray(node, "params");
  for (const param of params) {
    validateBindingPattern(param);
  }
  const callable = createOrdinaryObject() as VMUserFunction;
  const isArrow = node.type === "ArrowFunctionExpression";
  const constructable = options.constructable ?? (!isArrow && node.async !== true);

  defineUserFunctionProperty(callable, "name", name ?? "", { configurable: true, writable: false });
  defineUserFunctionProperty(callable, "length", getFunctionLength(params), {
    configurable: true,
    writable: false,
  });
  defineUserFunctionProperty(
    callable,
    "valueOf",
    createNativeFunctionObject(
      "Function.prototype.valueOf",
      (_args, _context, thisValue) => thisValue,
    ),
    { configurable: true, writable: true },
  );
  defineUserFunctionProperty(
    callable,
    "toString",
    createNativeFunctionObject("Function.prototype.toString", () => "[object Function]"),
    { configurable: true, writable: true },
  );

  if (constructable) {
    const prototype = createOrdinaryObject(getIntrinsics(context).objectPrototype);
    defineUserFunctionProperty(prototype, "constructor", callable, {
      configurable: true,
      writable: true,
    });
    defineUserFunctionProperty(callable, "prototype", prototype, {
      configurable: false,
      writable: true,
    });
  }

  userFunctionRecords.set(callable, {
    name,
    params,
    body: getNode(node, "body"),
    environment: context.lexicalEnvironment,
    lexicalThis: context.thisValue,
    arrow: isArrow,
    constructable,
    expressionBody: node.expression === true || getNode(node, "body").type !== "BlockStatement",
    async: node.async === true,
    homeObject: options.homeObject,
    privateEnvironment: options.privateEnvironment,
  });

  return callable;
}

function getFunctionLength(params: readonly ASTNode[]): number {
  let length = 0;
  for (const param of params) {
    if (param.type === "AssignmentPattern" || param.type === "RestElement") {
      break;
    }
    length += 1;
  }
  return length;
}

function validateBindingPattern(pattern: ASTNode): void {
  switch (pattern.type) {
    case "Identifier":
      assertSafeBindingName(getString(pattern, "name"));
      return;
    case "AssignmentPattern":
      validateBindingPattern(getNode(pattern, "left"));
      return;
    case "RestElement":
      validateBindingPattern(getNode(pattern, "argument"));
      return;
    case "ArrayPattern":
      for (const element of getUnknownArray(pattern, "elements")) {
        if (element !== null) {
          validateBindingPattern(asNode(element));
        }
      }
      return;
    case "ObjectPattern":
      for (const property of getNodeArray(pattern, "properties")) {
        if (property.type === "RestElement") {
          validateBindingPattern(getNode(property, "argument"));
          continue;
        }

        if (property.type !== "Property" || property.kind !== "init") {
          throw unsupportedNode(property, "Only plain object binding properties are supported.");
        }
        validateBindingPattern(getNode(property, "value"));
      }
      return;
    default:
      throw unsupportedNode(pattern, "Unsupported function parameter binding pattern.");
  }
}

async function bindFunctionParameters(
  params: readonly ASTNode[],
  args: readonly VMInternalValue[],
  context: VMExecutionContext,
  environment: VMEnvironment,
): Promise<void> {
  for (let index = 0; index < params.length; index += 1) {
    const param = params[index];
    if (param.type === "RestElement") {
      await bindPattern(
        getNode(param, "argument"),
        createGuestArray(args.slice(index), context),
        context,
        { environment, kind: "let", mutable: true },
      );
      return;
    }

    await bindPattern(param, args[index], context, { environment, kind: "let", mutable: true });
  }
}

async function invokeUserFunction(
  callable: VMUserFunction,
  args: readonly VMInternalValue[],
  callerContext: VMExecutionContext,
  thisValue: VMInternalValue = callerContext.globalObject,
  options: {
    readonly allowClassConstructor?: boolean;
    readonly construction?: VMDerivedConstructionState;
  } = {},
): Promise<VMInternalValue> {
  const record = userFunctionRecords.get(callable);
  if (record === undefined) {
    throw runtimeError("Unknown guest function.", { reason: "unknown callable" });
  }

  if (record.classInfo !== undefined && options.allowClassConstructor !== true) {
    throw runtimeError("Class constructors cannot be invoked without new.", {
      reason: "class constructor call",
    });
  }

  const previousLexical = callerContext.lexicalEnvironment;
  const previousVariable = callerContext.variableEnvironment;
  const previousThis = callerContext.thisValue;
  const functionEnvironment = createLexicalEnvironment(record.environment);

  callerContext.lexicalEnvironment = functionEnvironment;
  callerContext.variableEnvironment = functionEnvironment;
  callerContext.thisValue = record.arrow ? record.lexicalThis : thisValue;

  return evaluateWithFrame(
    callerContext,
    {
      construction: options.construction,
      homeObject: record.homeObject,
      privateEnvironment: record.privateEnvironment,
      record,
    },
    async () => {
      await bindFunctionParameters(record.params, args, callerContext, functionEnvironment);

      if (record.expressionBody) {
        return await evaluateExpression(record.body, callerContext);
      }

      const completion = await executeStatement(record.body, callerContext);
      if (completion.type === "return") {
        return completion.value;
      }

      if (completion.type === "normal") {
        return undefined;
      }

      if (completion.type === "throw") {
        throw new VMGuestException(completion.value);
      }

      throw runtimeError(`Unexpected ${completion.type} inside guest function.`, {
        reason: `unexpected ${completion.type} completion`,
      });
    },
  ).finally(() => {
    callerContext.lexicalEnvironment = previousLexical;
    callerContext.variableEnvironment = previousVariable;
    callerContext.thisValue = previousThis;
  });
}

async function evaluateAddition(
  left: VMInternalValue,
  right: VMInternalValue,
  context: VMExecutionContext,
): Promise<VMInternalValue> {
  const leftPrimitive = await toPrimitive(left, context, "default");
  const rightPrimitive = await toPrimitive(right, context, "default");
  if (typeof leftPrimitive === "string" || typeof rightPrimitive === "string") {
    return (
      toStringFromPrimitive(leftPrimitive, context) + toStringFromPrimitive(rightPrimitive, context)
    );
  }
  const leftNumeric = toNumericFromPrimitive(leftPrimitive, context);
  const rightNumeric = toNumericFromPrimitive(rightPrimitive, context);
  return applyNumericBinaryOperator(leftNumeric, rightNumeric, "+", context);
}

function applyNumericBinaryOperator(
  left: number | bigint,
  right: number | bigint,
  operator: "+" | "-" | "*" | "/" | "%" | "**",
  context: VMExecutionContext,
): number | bigint {
  if (typeof left !== typeof right) {
    throwGuestError(context, "TypeError", "Cannot mix BigInt and other numeric types.");
  }

  if (typeof left === "bigint") {
    const bigintRight = right as bigint;
    switch (operator) {
      case "+":
        return left + bigintRight;
      case "-":
        return left - bigintRight;
      case "*":
        return left * bigintRight;
      case "/":
        return left / bigintRight;
      case "%":
        return left % bigintRight;
      case "**":
        return left ** bigintRight;
    }
  }

  const numberRight = right as number;
  switch (operator) {
    case "+":
      return left + numberRight;
    case "-":
      return left - numberRight;
    case "*":
      return left * numberRight;
    case "/":
      return left / numberRight;
    case "%":
      return left % numberRight;
    case "**":
      return left ** numberRight;
  }
}

function applyBitwiseBinaryOperator(
  left: number | bigint,
  right: number | bigint,
  operator: "|" | "&" | "^" | "<<" | ">>" | ">>>",
  context: VMExecutionContext,
): number | bigint {
  if (typeof left !== typeof right) {
    throwGuestError(context, "TypeError", "Cannot mix BigInt and other numeric types.");
  }

  if (typeof left === "bigint") {
    if (operator === ">>>") {
      throwGuestError(context, "TypeError", "BigInts have no unsigned right shift operator.");
    }
    const bigintRight = right as bigint;
    switch (operator) {
      case "|":
        return left | bigintRight;
      case "&":
        return left & bigintRight;
      case "^":
        return left ^ bigintRight;
      case "<<":
        return left << bigintRight;
      case ">>":
        return left >> bigintRight;
    }
  }

  const numberRight = right as number;
  switch (operator) {
    case "|":
      return left | numberRight;
    case "&":
      return left & numberRight;
    case "^":
      return left ^ numberRight;
    case "<<":
      return left << numberRight;
    case ">>":
      return left >> numberRight;
    case ">>>":
      return left >>> numberRight;
  }
}

function applyUnaryMinus(value: number | bigint): number | bigint {
  return typeof value === "bigint" ? -value : -value;
}

function applyUnaryBitwiseNot(value: number | bigint): number | bigint {
  return typeof value === "bigint" ? ~value : ~value;
}

async function compareLessThan(
  left: VMInternalValue,
  right: VMInternalValue,
  context: VMExecutionContext,
): Promise<boolean | undefined> {
  const leftPrimitive = await toPrimitive(left, context, "number");
  const rightPrimitive = await toPrimitive(right, context, "number");
  if (typeof leftPrimitive === "string" && typeof rightPrimitive === "string") {
    return leftPrimitive < rightPrimitive;
  }
  if (typeof leftPrimitive === "bigint" && typeof rightPrimitive === "string") {
    try {
      return leftPrimitive < BigInt(rightPrimitive);
    } catch {
      return undefined;
    }
  }
  if (typeof leftPrimitive === "string" && typeof rightPrimitive === "bigint") {
    try {
      return BigInt(leftPrimitive) < rightPrimitive;
    } catch {
      return undefined;
    }
  }
  const leftNumeric = toNumericFromPrimitive(leftPrimitive, context);
  const rightNumeric = toNumericFromPrimitive(rightPrimitive, context);
  if (
    (typeof leftNumeric === "number" && Number.isNaN(leftNumeric)) ||
    (typeof rightNumeric === "number" && Number.isNaN(rightNumeric))
  ) {
    return undefined;
  }
  return leftNumeric < rightNumeric;
}

async function constructUserFunction(
  callable: VMUserFunction,
  args: readonly VMInternalValue[],
  context: VMExecutionContext,
  receiver?: VMObject,
): Promise<VMInternalValue> {
  const record = userFunctionRecords.get(callable);
  if (record === undefined || !record.constructable) {
    throw runtimeError("Guest function is not constructable.", {
      reason: "not constructable",
      valueType: guestTypeof(callable),
    });
  }

  if (record.classInfo !== undefined) {
    return constructClassFunction(callable, record, args, context, receiver);
  }

  const prototype = await getGuestProperty(callable, "prototype", context);
  const instance = receiver ?? createOrdinaryObject(isVMObject(prototype) ? prototype : null);
  const result = await invokeUserFunction(callable, args, context, instance);

  return isVMObject(result) ? result : instance;
}

async function constructClassFunction(
  callable: VMUserFunction,
  record: VMUserFunctionRecord,
  args: readonly VMInternalValue[],
  context: VMExecutionContext,
  receiver?: VMObject,
): Promise<VMInternalValue> {
  const classInfo = record.classInfo;
  if (classInfo === undefined) {
    throw runtimeError("Missing class metadata.", { reason: "missing class metadata" });
  }

  const instance = receiver ?? createOrdinaryObject(classInfo.prototype);

  if (classInfo.superClass === undefined) {
    await initializeClassInstanceElements(classInfo, instance, context);
    const result = await invokeUserFunction(callable, args, context, instance, {
      allowClassConstructor: true,
    });
    return isVMObject(result) ? result : instance;
  }

  if (classInfo.constructorMethod === undefined) {
    const result = await constructUserFunction(classInfo.superClass, args, context, instance);
    const initializedInstance = isVMObject(result) ? result : instance;
    await initializeClassInstanceElements(classInfo, initializedInstance, context);
    return initializedInstance;
  }

  const construction: VMDerivedConstructionState = {
    classInfo,
    derivedElementsInitialized: false,
    instance,
    superInitialized: false,
  };
  const result = await invokeUserFunction(callable, args, context, uninitializedThis, {
    allowClassConstructor: true,
    construction,
  });

  if (isVMObject(result)) {
    return result;
  }

  if (result !== undefined) {
    throw runtimeError("Derived class constructors may only return VM objects or undefined.", {
      reason: "invalid constructor return",
      valueType: guestTypeof(result),
    });
  }

  if (!construction.superInitialized) {
    throw runtimeError("Derived class constructor did not call super().", {
      reason: "missing super call",
    });
  }

  return construction.instance;
}

async function initializeClassInstanceElements(
  classInfo: VMClassInfo,
  instance: VMObject,
  context: VMExecutionContext,
): Promise<void> {
  await evaluateWithFrame(
    context,
    { homeObject: classInfo.prototype, privateEnvironment: classInfo.privateEnvironment },
    async () => {
      const previousThis = context.thisValue;
      const previousLexical = context.lexicalEnvironment;
      const previousVariable = context.variableEnvironment;
      context.thisValue = instance;
      context.lexicalEnvironment = classInfo.environment;
      context.variableEnvironment = classInfo.environment;
      try {
        for (const element of classInfo.instanceElements) {
          if (element.kind === "private" && element.entry.kind !== "field-initializer") {
            definePrivateSlot(instance, element.name, element.entry);
          }
        }

        for (const element of classInfo.instanceElements) {
          if (element.kind === "field") {
            const value =
              element.value === undefined
                ? undefined
                : await evaluateExpression(element.value, context);
            defineDataProperty(instance, element.key, value);
            continue;
          }

          if (element.entry.kind === "field-initializer") {
            const value =
              element.entry.value === undefined
                ? undefined
                : await evaluateExpression(element.entry.value, context);
            definePrivateSlot(instance, element.name, { kind: "field", value });
          }
        }
      } finally {
        context.thisValue = previousThis;
        context.lexicalEnvironment = previousLexical;
        context.variableEnvironment = previousVariable;
      }
    },
  );
}

function defineUserFunctionProperty(
  object: VMObject,
  key: string,
  value: VMInternalValue,
  options: { readonly configurable: boolean; readonly writable: boolean },
): void {
  const defined = defineOwnProperty(object, key, {
    configurable: options.configurable,
    enumerable: false,
    kind: "data",
    value,
    writable: options.writable,
  });

  if (!defined) {
    throw runtimeError("Unable to define guest function property.", {
      path: key,
      reason: "property definition failed",
    });
  }
}

async function applyAssignmentOperator(
  operator: string,
  left: VMInternalValue,
  right: VMInternalValue,
  context: VMExecutionContext,
): Promise<VMInternalValue> {
  switch (operator) {
    case "+=":
      return evaluateAddition(left, right, context);
    case "-=":
      return applyNumericBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        "-",
        context,
      );
    case "*=":
      return applyNumericBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        "*",
        context,
      );
    case "/=":
      return applyNumericBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        "/",
        context,
      );
    case "%=":
      return applyNumericBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        "%",
        context,
      );
    case "**=":
      return applyNumericBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        "**",
        context,
      );
    case "|=":
      return applyBitwiseBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        "|",
        context,
      );
    case "&=":
      return applyBitwiseBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        "&",
        context,
      );
    case "^=":
      return applyBitwiseBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        "^",
        context,
      );
    case "<<=":
      return applyBitwiseBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        "<<",
        context,
      );
    case ">>=":
      return applyBitwiseBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        ">>",
        context,
      );
    case ">>>=":
      return applyBitwiseBinaryOperator(
        await toNumeric(left, context),
        await toNumeric(right, context),
        ">>>",
        context,
      );
    case "&&=":
      return isTruthy(left) ? right : left;
    case "||=":
      return isTruthy(left) ? left : right;
    case "??=":
      return left === null || left === undefined ? right : left;
    default:
      throw runtimeError(`Unsupported assignment operator ${operator}.`, {
        reason: "unsupported assignment operator",
      });
  }
}

function importGuestValue(value: unknown, path: string, intrinsics: VMIntrinsics): VMInternalValue {
  if (isVMObject(value)) {
    return value;
  }

  if (isVMSymbol(value)) {
    return value;
  }

  if (isHostCallable(value)) {
    return value;
  }

  if (isNativeCallable(value)) {
    return value;
  }

  if (
    (Array.isArray(value) || isPlainObject(value)) &&
    !containsHostCallable(value, new WeakSet<object>())
  ) {
    return importSerializedBoundaryValue(
      serializeBoundaryValue(value, { allowCapabilities: false }),
      path,
      intrinsics,
    );
  }

  if (Array.isArray(value)) {
    const output = createArrayLikeObject([], intrinsics.arrayPrototype);
    const descriptors = Object.getOwnPropertyDescriptors(value);

    for (const key of Object.keys(descriptors)) {
      if (key !== "length" && !isArrayIndex(key)) {
        throw securityError("Arrays cannot carry custom properties into the VM.", {
          reason: "array custom property",
          path: `${path}.${key}`,
        });
      }
    }

    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      defineDataProperty(
        output,
        String(index),
        descriptor === undefined
          ? undefined
          : importGuestValue(
              readDataDescriptor(descriptor, `${path}[${index}]`),
              `${path}[${index}]`,
              intrinsics,
            ),
      );
    }
    return output;
  }

  if (isPlainObject(value)) {
    const output = createOrdinaryObject(intrinsics.objectPrototype);
    const descriptors = Object.getOwnPropertyDescriptors(value);

    for (const [key, descriptor] of Object.entries(descriptors)) {
      if ("get" in descriptor || "set" in descriptor) {
        throw securityError("Accessor globals cannot be imported into the VM.", {
          path: `${path}.${key}`,
          reason: "accessor global",
        });
      }
      const defined = defineOwnProperty(output, key, {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        kind: "data",
        value: importGuestValue(descriptor.value, `${path}.${key}`, intrinsics),
        writable: descriptor.writable,
      });
      if (!defined) {
        throw runtimeError("Unable to import VM global property.", {
          path: `${path}.${key}`,
          reason: "property definition failed",
        });
      }
    }
    return output;
  }

  return importSerializedBoundaryValue(
    serializeBoundaryValue(value, { allowCapabilities: false }),
    path,
    intrinsics,
  );
}

function importSerializedBoundaryValue(
  value: BoundarySerializedValue,
  path: string,
  intrinsics: VMIntrinsics,
): VMInternalValue {
  switch (value.kind) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "boolean":
    case "number":
    case "string":
      return value.value;
    case "bigint":
      return BigInt(value.value);
    case "array": {
      const output = createArrayLikeObject([], intrinsics.arrayPrototype);

      for (let index = 0; index < value.items.length; index += 1) {
        defineDataProperty(
          output,
          String(index),
          importSerializedBoundaryValue(value.items[index], `${path}[${index}]`, intrinsics),
        );
      }

      return output;
    }
    case "object": {
      const output = createOrdinaryObject(intrinsics.objectPrototype);

      for (const [key, child] of value.entries) {
        defineDataProperty(
          output,
          key,
          importSerializedBoundaryValue(child, `${path}.${key}`, intrinsics),
        );
      }

      return output;
    }
    case "date":
      return createDateObject(value.time, intrinsics);
    case "regexp":
      return createRegExpObject(value.source, value.flags, value.lastIndex, intrinsics);
    case "map":
      return createMapObject(
        value.entries.map(
          ([key, entryValue], index) =>
            [
              importSerializedBoundaryValue(key, `${path}<map[${index}].key>`, intrinsics),
              importSerializedBoundaryValue(entryValue, `${path}<map[${index}].value>`, intrinsics),
            ] as const,
        ),
        intrinsics,
      );
    case "set":
      return createSetObject(
        value.values.map((child, index) =>
          importSerializedBoundaryValue(child, `${path}<set[${index}]>`, intrinsics),
        ),
        intrinsics,
      );
    case "arrayBuffer":
      return createArrayBufferObject(bytesToArrayBuffer(value.bytes), intrinsics);
    case "typedArray":
      return createTypedArrayObject(value.type, value.bytes, intrinsics);
    case "dataView":
      return createDataViewObject(value.bytes, intrinsics);
    case "capability":
      throw securityError("Capabilities cannot enter the VM as ordinary values.", { path });
  }
}

function containsHostCallable(value: unknown, seen: WeakSet<object>): boolean {
  if (isHostCallable(value)) {
    return true;
  }

  if (isNativeCallable(value)) {
    return true;
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);

    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor !== undefined &&
        "value" in descriptor &&
        containsHostCallable(descriptor.value, seen)
      ) {
        return true;
      }
    }

    return false;
  }

  if (isPlainObject(value)) {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if ("value" in descriptor && containsHostCallable(descriptor.value, seen)) {
        return true;
      }
    }

    return false;
  }

  return false;
}

async function exportGuestValue(
  value: VMInternalValue,
  context: VMExecutionContext,
): Promise<VMSerializableValue> {
  return exportGuestValueAtPath(value, "$", context);
}

async function exportGuestValueAtPath(
  value: VMInternalValue,
  path: string,
  context: VMExecutionContext,
): Promise<VMSerializableValue> {
  return serializeAndReconstructBoundaryValue(
    await prepareGuestValueForBoundary(value, path, new WeakSet<object>(), context),
    { allowCapabilities: false },
  );
}

async function exportGuestArguments(
  args: readonly VMInternalValue[],
  context: VMExecutionContext,
): Promise<VMSerializableValue[]> {
  const hostArgs: VMSerializableValue[] = [];

  for (let index = 0; index < args.length; index += 1) {
    hostArgs.push(await exportGuestValueAtPath(args[index], `$[${index}]`, context));
  }

  return hostArgs;
}

async function prepareGuestValueForBoundary(
  value: VMInternalValue,
  path: string,
  active: WeakSet<object>,
  context: VMExecutionContext,
): Promise<unknown> {
  if (isVMSymbol(value)) {
    throw new VMError(
      VMErrorCode.BoundaryUnsupportedType,
      "Symbols cannot cross the VM boundary.",
      { path, valueType: "symbol" },
    );
  }

  if (isCallableValue(value)) {
    throw new VMError(
      VMErrorCode.BoundaryUnsupportedType,
      "Guest callables cannot cross the VM boundary as values.",
      { path, valueType: "function" },
    );
  }

  if (isVMObject(value)) {
    if (regexpSlots.has(value)) {
      const slot = assertRegExpSlot(value);
      const lastIndex = getOwnPropertyDescriptor(value, "lastIndex");
      const regexp = new RegExp(slot.regexp.source, slot.regexp.flags);
      regexp.lastIndex =
        lastIndex?.kind === "data" ? Number(lastIndex.value) : slot.regexp.lastIndex;
      return regexp;
    }
    if (dateSlots.has(value)) {
      return new Date(assertDateSlot(value).time);
    }
    if (mapSlots.has(value)) {
      const output = new Map<unknown, unknown>();
      for (const entry of assertMapSlot(value).entries) {
        output.set(
          await prepareGuestValueForBoundary(entry.key, `${path}<map.key>`, active, context),
          await prepareGuestValueForBoundary(entry.value, `${path}<map.value>`, active, context),
        );
      }
      return output;
    }
    if (setSlots.has(value)) {
      const output = new Set<unknown>();
      let index = 0;
      for (const entry of assertSetSlot(value).values) {
        output.add(
          await prepareGuestValueForBoundary(entry, `${path}<set[${index}]>`, active, context),
        );
        index += 1;
      }
      return output;
    }
    if (arrayBufferSlots.has(value)) {
      return arrayBufferSlots.get(value)!.slice(0);
    }
    if (typedArraySlots.has(value)) {
      const slot = typedArraySlots.get(value)!;
      return reconstructTypedArrayForBoundary(slot.type, slot.bytes);
    }
    if (dataViewSlots.has(value)) {
      return new DataView(bytesToArrayBuffer(dataViewSlots.get(value)!));
    }
    return prepareVMObjectForBoundary(value, path, active, context);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  if (active.has(value)) {
    throw new VMError(VMErrorCode.BoundaryCycle, "Cannot serialize cyclic VM values.", {
      path,
      valueType: "object",
    });
  }
  active.add(value);

  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        output[index] = await prepareGuestValueForBoundary(
          value[index],
          `${path}[${index}]`,
          active,
          context,
        );
      }
      return output;
    }

    if (isPlainObject(value)) {
      const output = Object.create(null) as Record<string, unknown>;
      for (const [key, child] of Object.entries(value as Record<string, VMInternalValue>)) {
        output[key] = await prepareGuestValueForBoundary(child, `${path}.${key}`, active, context);
      }
      return output;
    }

    return value;
  } finally {
    active.delete(value);
  }
}

async function prepareVMObjectForBoundary(
  object: VMObject,
  path: string,
  active: WeakSet<object>,
  context: VMExecutionContext,
): Promise<unknown> {
  if (active.has(object)) {
    throw new VMError(VMErrorCode.BoundaryCycle, "Cannot serialize cyclic VM values.", {
      path,
      valueType: "object",
    });
  }
  active.add(object);

  try {
    if (isArrayLikeObject(object)) {
      return prepareVMArrayForBoundary(object, path, active, context);
    }

    const output = Object.create(null) as Record<string, unknown>;
    for (const key of await ownKeysGuest(object, context)) {
      if (isVMSymbol(key)) {
        throw new VMError(
          VMErrorCode.BoundaryUnsupportedType,
          "Objects with symbol properties cannot cross the VM boundary.",
          { path, valueType: "symbol" },
        );
      }

      const descriptor = await getOwnPropertyDescriptorGuest(object, key, context);
      if (descriptor === undefined || !descriptor.enumerable) {
        continue;
      }

      output[key] = await prepareGuestValueForBoundary(
        descriptor.kind === "data"
          ? descriptor.value
          : await getGuestProperty(object, key, context),
        pathForProperty(path, key),
        active,
        context,
      );
    }
    return output;
  } finally {
    active.delete(object);
  }
}

async function prepareVMArrayForBoundary(
  object: VMObject,
  path: string,
  active: WeakSet<object>,
  context: VMExecutionContext,
): Promise<unknown[]> {
  const length = await getArrayLengthValue(object, context);
  const output = new Array<unknown>(length);

  for (const key of await ownKeysGuest(object, context)) {
    if (isVMSymbol(key)) {
      throw new VMError(
        VMErrorCode.BoundaryUnsupportedType,
        "Arrays with symbol properties cannot cross the VM boundary.",
        { path, valueType: "symbol" },
      );
    }

    if (key === "length") {
      continue;
    }

    if (!isArrayIndex(key)) {
      throw new VMError(
        VMErrorCode.BoundaryUnsupportedType,
        "Arrays cannot carry custom properties.",
        { path: pathForProperty(path, key), valueType: "object" },
      );
    }
  }

  for (let index = 0; index < length; index += 1) {
    output[index] = await prepareGuestValueForBoundary(
      await getGuestProperty(object, String(index), context),
      `${path}[${index}]`,
      active,
      context,
    );
  }

  return output;
}

function asGuestObject(value: VMInternalValue): VMObject {
  if (isHostCallable(value) || isNativeCallable(value)) {
    throw runtimeError("Callable values do not expose VM object properties.", {
      reason: "callable member access",
    });
  }

  if (isVMObject(value)) {
    return value;
  }

  throw runtimeError("Member expressions are only supported for VM-owned objects and arrays.", {
    reason: "unsupported member base",
    valueType: guestTypeof(value),
  });
}

function assertSafeBindingName(name: string): void {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    throw securityError(`Invalid guest binding name "${name}".`, { path: name });
  }
}

function guestTypeof(value: VMInternalValue): string {
  if (isCallableValue(value)) {
    return "function";
  }

  if (isVMSymbol(value)) {
    return "symbol";
  }

  if (value === null) {
    return "object";
  }

  return typeof value;
}

function isUserFunction(value: unknown): value is VMUserFunction {
  return (
    typeof value === "object" && value !== null && userFunctionRecords.has(value as VMUserFunction)
  );
}

function isNativeFunctionObject(value: unknown): value is VMObject {
  return isVMObject(value) && nativeFunctionRecords.has(value);
}

function isCallableValue(value: unknown): boolean {
  if (isProxyObject(value)) {
    return isCallableValue(getProxySlot(value).target);
  }
  return (
    isHostCallable(value) ||
    isNativeCallable(value) ||
    isUserFunction(value) ||
    isNativeFunctionObject(value)
  );
}

function isConstructableValue(value: unknown): boolean {
  if (isProxyObject(value)) {
    return isConstructableValue(getProxySlot(value).target);
  }
  if (isNativeCallable(value)) {
    return value.constructable;
  }
  if (isNativeFunctionObject(value)) {
    return nativeFunctionRecords.get(value)?.construct !== undefined;
  }
  if (isUserFunction(value)) {
    return userFunctionRecords.get(value)?.constructable === true;
  }
  return false;
}

function getNativeFunctionName(value: VMObject): string {
  const descriptor = getOwnPropertyDescriptor(value, "name");
  return descriptor?.kind === "data" && typeof descriptor.value === "string"
    ? descriptor.value
    : "native";
}

function createNativeTools(context: VMExecutionContext): VMNativeCallableTools {
  return {
    async invokeGuestCallable(callable, args) {
      const importedArgs = args.map((arg, index) =>
        importGuestValue(arg, `<native-callback>[${index}]`, getIntrinsics(context)),
      );

      if (isUserFunction(callable)) {
        return invokeUserFunction(callable, importedArgs, context, context.globalObject);
      }

      if (isNativeCallable(callable)) {
        return invokeNativeCallable(
          callable,
          importedArgs,
          context,
          undefined,
          createNativeTools(context),
        );
      }

      if (isNativeFunctionObject(callable)) {
        const record = nativeFunctionRecords.get(callable);
        return record!.call(importedArgs, context, undefined);
      }

      if (isHostCallable(callable)) {
        const hostArgs = await exportGuestArguments(importedArgs, context);
        return importGuestValue(
          await invokeHostCallable(callable, hostArgs),
          "<callback-result>",
          getIntrinsics(context),
        );
      }

      throwGuestError(context, "TypeError", "Value is not callable in the VM.");
    },
  };
}

async function evaluateWithFrame<T>(
  context: VMExecutionContext,
  frame: VMCallFrame,
  callback: () => Promise<T>,
): Promise<T> {
  const frames = contextFrames.get(context) ?? [];
  frames.push(frame);
  contextFrames.set(context, frames);

  try {
    return await callback();
  } finally {
    frames.pop();
    if (frames.length === 0) {
      contextFrames.delete(context);
    }
  }
}

function currentFrame(context: VMExecutionContext): VMCallFrame | undefined {
  const frames = contextFrames.get(context);
  return frames === undefined ? undefined : frames[frames.length - 1];
}

function getThisValue(context: VMExecutionContext): VMInternalValue {
  if (context.thisValue === uninitializedThis) {
    throw runtimeError("Cannot access this before super() in a derived constructor.", {
      reason: "uninitialized this",
    });
  }
  return context.thisValue;
}

function getSuperBase(context: VMExecutionContext): VMObject | null {
  const homeObject = currentFrame(context)?.homeObject;
  if (homeObject === undefined) {
    throw runtimeError("super property access is only supported inside class methods and fields.", {
      reason: "invalid super property",
    });
  }

  return getPrototypeOf(homeObject);
}

function resolvePrivateName(name: string, context: VMExecutionContext): VMPrivateName {
  const privateName = currentFrame(context)?.privateEnvironment?.get(name);
  if (privateName === undefined) {
    throw runtimeError(`Private name #${name} is not declared in this class scope.`, {
      reason: "unknown private name",
      path: name,
    });
  }
  return privateName;
}

function definePrivateSlot(object: VMObject, name: VMPrivateName, entry: VMPrivateEntry): void {
  let slots = privateSlots.get(object);
  if (slots === undefined) {
    slots = new Map();
    privateSlots.set(object, slots);
  }

  const existing = slots.get(name);
  if (existing !== undefined && existing.kind === "accessor" && entry.kind === "accessor") {
    slots.set(name, {
      get: entry.get ?? existing.get,
      kind: "accessor",
      set: entry.set ?? existing.set,
    });
    return;
  }

  if (existing !== undefined) {
    throw runtimeError(`Private name #${name.description} is already initialized.`, {
      reason: "duplicate private name",
      path: name.description,
    });
  }

  slots.set(name, entry);
}

function getPrivateSlot(object: VMObject, name: VMPrivateName): VMPrivateEntry {
  const entry = privateSlots.get(object)?.get(name);
  if (entry === undefined) {
    throw runtimeError(`Cannot access private name #${name.description} on this object.`, {
      reason: "missing private slot",
      path: name.description,
    });
  }
  return entry;
}

function isTruthy(value: VMInternalValue): boolean {
  return Boolean(value);
}

function isNullish(value: VMInternalValue): boolean {
  return value === null || value === undefined;
}

async function toPropertyKey(
  value: VMInternalValue,
  context: VMExecutionContext,
): Promise<VMPropertyKey> {
  const key = await toPrimitive(value, context, "string");
  if (isVMSymbol(key)) {
    return key;
  }

  if (typeof key === "symbol") {
    throw securityError("Host symbols cannot be used as VM property keys.", {
      reason: "host symbol property key",
    });
  }
  return toStringFromPrimitive(key, context);
}

function propertyKeyToString(key: VMPropertyKey): string {
  return isVMSymbol(key) ? describeVMSymbol(key) : key;
}

function propertyKeyToFunctionName(key: VMPropertyKey): string {
  return isVMSymbol(key) ? `[${describeVMSymbol(key)}]` : key;
}

function pathForProperty(path: string, key: VMPropertyKey): string {
  if (isVMSymbol(key)) {
    return `${path}[${describeVMSymbol(key)}]`;
  }
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

async function toPrimitive(
  value: VMInternalValue,
  context: VMExecutionContext,
  hint: "default" | "number" | "string" = "default",
): Promise<VMInternalValue> {
  if (!isObjectValue(value)) {
    return value;
  }

  if (!isVMObject(value)) {
    return value;
  }

  const method = await getGuestProperty(
    value,
    getIntrinsics(context).wellKnownSymbols.toPrimitive,
    context,
  );
  if (method !== undefined && method !== null) {
    if (!isCallableValue(method)) {
      throwGuestError(context, "TypeError", "Symbol.toPrimitive method must be callable.");
    }
    const result = await invokeCallableValue(method, [hint], context, value, value);
    if (isObjectValue(result)) {
      throwGuestError(
        context,
        "TypeError",
        "Symbol.toPrimitive method must return a primitive value.",
      );
    }
    return result;
  }

  const unboxed = unboxPrimitive(value);
  if (!isVMObject(unboxed)) {
    return unboxed;
  }

  return ordinaryToPrimitive(value, context, hint);
}

async function toNumber(value: VMInternalValue, context: VMExecutionContext): Promise<number> {
  const primitive = await toPrimitive(value, context, "number");
  return toNumberFromPrimitive(primitive, context);
}

async function toNumeric(
  value: VMInternalValue,
  context: VMExecutionContext,
): Promise<number | bigint> {
  const primitive = await toPrimitive(value, context, "number");
  return toNumericFromPrimitive(primitive, context);
}

function toNumericFromPrimitive(
  primitive: VMInternalValue,
  context: VMExecutionContext,
): number | bigint {
  if (typeof primitive === "bigint") {
    return primitive;
  }
  return toNumberFromPrimitive(primitive, context);
}

function toNumberFromPrimitive(primitive: VMInternalValue, context: VMExecutionContext): number {
  if (isVMSymbol(primitive)) {
    throwGuestError(context, "TypeError", "Cannot convert a Symbol value to a number.");
  }
  if (typeof primitive === "bigint") {
    throwGuestError(context, "TypeError", "Cannot convert a BigInt value to a number.");
  }
  return Number(primitive);
}

async function ordinaryToPrimitive(
  object: VMObject,
  context: VMExecutionContext,
  hint: "default" | "number" | "string",
): Promise<VMInternalValue> {
  const methodNames =
    hint === "string" || (hint === "default" && dateSlots.has(object))
      ? ["toString", "valueOf"]
      : ["valueOf", "toString"];

  for (const methodName of methodNames) {
    const method = await getGuestProperty(object, methodName, context);
    if (!isCallableValue(method)) {
      continue;
    }

    const result = await invokeCallableValue(method, [], context, object, object);
    if (!isObjectValue(result)) {
      return result;
    }
  }

  throwGuestError(context, "TypeError", "Cannot convert object to primitive value.");
}

function isObjectValue(value: VMInternalValue): boolean {
  return isVMObject(value) || isHostCallable(value) || isNativeCallable(value);
}

async function toStringExplicit(
  value: VMInternalValue,
  context: VMExecutionContext,
): Promise<string> {
  if (value === undefined) {
    return "";
  }
  if (isVMSymbol(value)) {
    return describeVMSymbol(value);
  }
  const primitive = await toPrimitive(value, context, "string");
  if (isVMSymbol(primitive)) {
    return describeVMSymbol(primitive);
  }
  return toStringFromPrimitive(primitive, context, true);
}

async function toStringForCoercion(
  value: VMInternalValue,
  context: VMExecutionContext,
): Promise<string> {
  const primitive = await toPrimitive(value, context, "string");
  return toStringFromPrimitive(primitive, context);
}

function toStringFromPrimitive(
  primitive: VMInternalValue,
  context: VMExecutionContext,
  allowSymbol = false,
): string {
  if (isVMSymbol(primitive)) {
    if (allowSymbol) {
      return describeVMSymbol(primitive);
    }
    throwGuestError(context, "TypeError", "Cannot convert a Symbol value to a string.");
  }
  return String(primitive);
}

function isArrayIndex(key: VMPropertyKey): key is string {
  if (typeof key !== "string") {
    return false;
  }
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readDataDescriptor(descriptor: PropertyDescriptor, path: string): unknown {
  if (!descriptor.enumerable) {
    throw securityError("Values entering the VM must be enumerable.", { path });
  }

  if (!("value" in descriptor)) {
    throw securityError("Accessor properties cannot enter the VM.", { path });
  }

  return descriptor.value;
}

function hasCompletionValue(completion: VMCompletion): boolean {
  return hasOwn.call(completion, "value");
}

function normalizeEvaluatorError(error: unknown): VMError {
  if (error instanceof VMError) {
    return error;
  }

  if (error instanceof Error) {
    return new VMError(VMErrorCode.VMRuntimeError, error.message, { valueType: error.name });
  }

  return new VMError(VMErrorCode.VMRuntimeError, String(error), { valueType: typeof error });
}

function runtimeError(message: string, details: Record<string, string | undefined> = {}): VMError {
  return new VMError(VMErrorCode.VMRuntimeError, message, details);
}

function syntaxError(message: string, details: Record<string, string | undefined> = {}): VMError {
  return new VMError(VMErrorCode.VMSyntaxError, message, details);
}

function securityError(message: string, details: Record<string, string | undefined> = {}): VMError {
  return new VMError(VMErrorCode.VMSecurityError, message, details);
}

function throwGuestError(context: VMExecutionContext, name: VMErrorName, message: string): never {
  throw new VMGuestException(createErrorObject(name, message, getIntrinsics(context)));
}

function unsupportedNode(node: ASTNode, message = `Unsupported AST node ${node.type}.`): VMError {
  return new VMError(VMErrorCode.VMRuntimeError, message, {
    reason: "unsupported syntax",
    path: node.type,
  });
}

function assertNodeType(node: ASTNode, type: string): void {
  if (node.type !== type) {
    throw unsupportedNode(node, `Expected ${type}, received ${node.type}.`);
  }
}

function asNode(value: unknown): ASTNode {
  if (typeof value !== "object" || value === null || typeof (value as ASTNode).type !== "string") {
    throw runtimeError("Expected an AST node.", { reason: "invalid ast" });
  }
  return value as ASTNode;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw runtimeError(`Expected ${label}.`, { reason: "invalid ast" });
  }
  return value as Record<string, unknown>;
}

function getNode(node: ASTNode, key: string): ASTNode {
  return asNode(node[key]);
}

function getNodeArray(node: ASTNode, key: string): readonly ASTNode[] {
  return getUnknownArray(node, key).map(asNode);
}

function getUnknownArray(node: ASTNode, key: string): readonly unknown[] {
  const value = node[key];
  if (!Array.isArray(value)) {
    throw runtimeError(`Expected AST array property ${key}.`, { reason: "invalid ast" });
  }
  return value;
}

function getString(node: ASTNode, key: string): string {
  const value = node[key];
  if (typeof value !== "string") {
    throw runtimeError(`Expected AST string property ${key}.`, { reason: "invalid ast" });
  }
  return value;
}

function getOptionalIdentifierName(node: ASTNode, key: string): string | undefined {
  const value = node[key];
  if (value === null || value === undefined) {
    return undefined;
  }

  const identifier = asNode(value);
  if (identifier.type !== "Identifier") {
    throw unsupportedNode(identifier, "Only identifier labels and names are supported.");
  }
  return getString(identifier, "name");
}
