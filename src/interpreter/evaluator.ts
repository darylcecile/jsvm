import {
  VMError,
  VMErrorCode,
  serializeAndReconstructBoundaryValue,
  serializeBoundaryValue,
  type VMSerializableValue,
  type VMSerializedValue,
} from "../boundary";
import { parseProgram, type VMProgram } from "../parser";
import { VMEnvironment, createGlobalEnvironment, createLexicalEnvironment } from "./environment";
import {
  VMExecutionContext,
  createExecutionContext,
  type ExecutionBudgetOptions,
  type VMCompletion,
  breakCompletion,
  continueCompletion,
  normalCompletion,
  returnCompletion,
} from "./runtime";
import {
  constructNativeCallable,
  invokeHostCallable,
  invokeNativeCallable,
  isHostCallable,
  isNativeCallable,
  type VMGuestCallable,
  type VMNativeCallableTools,
} from "./values";

export interface VMEvaluatorContextOptions {
  readonly globals?: Readonly<Record<string, unknown>>;
  readonly budget?: ExecutionBudgetOptions;
}

export interface VMEvaluatorOptions {
  readonly context?: VMExecutionContext;
  readonly globals?: Readonly<Record<string, unknown>>;
  readonly budget?: ExecutionBudgetOptions;
}

type ASTNode = {
  readonly type: string;
  readonly [key: string]: unknown;
};

type VMInternalValue = unknown;
type Reference = BindingReference | MemberReference;

interface BindingReference {
  readonly kind: "binding";
  readonly name: string;
  get(): VMInternalValue;
  set(value: VMInternalValue): VMInternalValue;
  delete(): boolean;
}

interface MemberReference {
  readonly kind: "member";
  readonly object: VMObjectContainer;
  readonly key: string;
  get(): VMInternalValue;
  set(value: VMInternalValue): VMInternalValue;
  delete(): boolean;
}

type VMObjectContainer = VMArray | VMRecord;
type VMArray = VMInternalValue[];
type VMRecord = Record<string, VMInternalValue>;

interface VMUserFunction {
  readonly kind: "guest-function";
  readonly name?: string;
  readonly length: number;
}

interface VMUserFunctionRecord {
  readonly name?: string;
  readonly params: readonly string[];
  readonly body: ASTNode;
  readonly environment: VMEnvironment;
  readonly expressionBody: boolean;
  readonly async: boolean;
}

const hasOwn = Object.prototype.hasOwnProperty;
const vmOwnedObjects = new WeakSet<object>();
const userFunctionRecords = new WeakMap<VMUserFunction, VMUserFunctionRecord>();

export function createEvaluatorContext(
  options: VMEvaluatorContextOptions = {},
): VMExecutionContext {
  const globalEnvironment = createGlobalEnvironment();

  for (const [name, value] of Object.entries(options.globals ?? {})) {
    assertSafeBindingName(name);
    globalEnvironment.define(name, {
      kind: "var",
      mutable: true,
      deletable: true,
      initialized: true,
      value: importGuestValue(value, name),
    });
  }

  return createExecutionContext({
    globalEnvironment,
    lexicalEnvironment: globalEnvironment,
    variableEnvironment: globalEnvironment,
    budget: options.budget,
  });
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

    return exportGuestValue(completion.value);
  } catch (error) {
    throw normalizeEvaluatorError(error);
  }
}

export function serializeGuestValueForSnapshot(
  value: unknown,
  path = "$",
): VMSerializedValue {
  assertNoCallableReferences(value, path, new WeakSet<object>());
  return serializeBoundaryValue(value, { allowCapabilities: false });
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
    case "IfStatement":
      return executeIfStatement(statement, context);
    case "WhileStatement":
      return executeWhileStatement(statement, context);
    case "ForStatement":
      return executeForStatement(statement, context);
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
      throw runtimeError("Guest code threw a value.", {
        reason: "throw statement",
        valueType: typeof (await evaluateExpression(getNode(statement, "argument"), context)),
      });
    default:
      throw unsupportedNode(statement);
  }
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
      if (test !== null && test !== undefined && !isTruthy(await evaluateExpression(asNode(test), context))) {
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

async function executeVariableDeclaration(
  declaration: ASTNode,
  context: VMExecutionContext,
): Promise<void> {
  const kind = getString(declaration, "kind") as "var" | "let" | "const";
  const target = kind === "var" ? context.variableEnvironment : context.lexicalEnvironment;

  for (const declarator of getNodeArray(declaration, "declarations")) {
    const id = getNode(declarator, "id");
    if (id.type !== "Identifier") {
      throw unsupportedNode(id, "Only identifier bindings are supported in declarations.");
    }

    const name = getString(id, "name");
    assertSafeBindingName(name);
    const init = declarator.init;
    const value = init === null || init === undefined ? undefined : await evaluateExpression(asNode(init), context);

    if (kind === "var") {
      if (!target.hasOwn(name)) {
        target.define(name, { kind: "var", mutable: true, deletable: true, initialized: true });
      }
      if (init !== null && init !== undefined) {
        target.set(name, value);
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
      return evaluateLiteral(expression);
    case "Identifier": {
      const name = getString(expression, "name");
      return createBindingReference(name, context).get();
    }
    case "ThisExpression":
      throw securityError("Guest code cannot use this to reach a host global object.", {
        reason: "this expression",
      });
    case "ArrayExpression":
      return evaluateArrayExpression(expression, context);
    case "ObjectExpression":
      return evaluateObjectExpression(expression, context);
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return createUserFunction(expression, context, getOptionalIdentifierName(expression, "id"));
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

function evaluateLiteral(expression: ASTNode): VMInternalValue {
  if (hasOwn.call(expression, "regex") && expression.regex !== undefined) {
    throw unsupportedNode(expression, "RegExp literals are not supported yet.");
  }

  return expression.value;
}

async function evaluateArrayExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<VMArray> {
  const array = createVMArray();
  const elements = getUnknownArray(expression, "elements");

  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    array[index] = element === null ? undefined : await evaluateExpression(asNode(element), context);
  }

  return array;
}

async function evaluateObjectExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<VMRecord> {
  const object = createVMRecord();

  for (const property of getNodeArray(expression, "properties")) {
    if (property.type !== "Property") {
      throw unsupportedNode(property, "Only plain object properties are supported.");
    }

    if (property.kind !== "init") {
      throw unsupportedNode(property, "Getters and setters are not supported.");
    }

    if (property.method === true) {
      throw unsupportedNode(property, "Object methods are not supported yet.");
    }

    const key = await propertyKeyFromProperty(property, context);
    object[key] = await evaluateExpression(getNode(property, "value"), context);
  }

  return object;
}

async function evaluateAssignmentExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<VMInternalValue> {
  const reference = await evaluateReference(getNode(expression, "left"), context);
  const operator = getString(expression, "operator");

  if (operator === "=") {
    return reference.set(await evaluateExpression(getNode(expression, "right"), context));
  }

  const left = reference.get();
  const right = await evaluateExpression(getNode(expression, "right"), context);
  const value = applyAssignmentOperator(operator, left, right);
  return reference.set(value);
}

async function evaluateUpdateExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<VMInternalValue> {
  const reference = await evaluateReference(getNode(expression, "argument"), context);
  const oldValue = Number(reference.get());
  const operator = getString(expression, "operator");
  const nextValue = operator === "++" ? oldValue + 1 : oldValue - 1;
  reference.set(nextValue);
  return expression.prefix === true ? nextValue : oldValue;
}

async function evaluateBinaryExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<VMInternalValue> {
  const left = await evaluateExpression(getNode(expression, "left"), context);
  const right = await evaluateExpression(getNode(expression, "right"), context);

  switch (getString(expression, "operator")) {
    case "+":
      return (left as number) + (right as number);
    case "-":
      return Number(left) - Number(right);
    case "*":
      return Number(left) * Number(right);
    case "/":
      return Number(left) / Number(right);
    case "%":
      return Number(left) % Number(right);
    case "**":
      return Number(left) ** Number(right);
    case "<":
      return (left as number) < (right as number);
    case "<=":
      return (left as number) <= (right as number);
    case ">":
      return (left as number) > (right as number);
    case ">=":
      return (left as number) >= (right as number);
    case "==":
      return left == right;
    case "!=":
      return left != right;
    case "===":
      return left === right;
    case "!==":
      return left !== right;
    case "|":
      return Number(left) | Number(right);
    case "&":
      return Number(left) & Number(right);
    case "^":
      return Number(left) ^ Number(right);
    case "<<":
      return Number(left) << Number(right);
    case ">>":
      return Number(left) >> Number(right);
    case ">>>":
      return Number(left) >>> Number(right);
    case "in":
      return hasGuestProperty(right, toPropertyKey(left));
    default:
      throw unsupportedNode(expression, `Unsupported binary operator ${getString(expression, "operator")}.`);
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
    return left === null || left === undefined ? evaluateExpression(getNode(expression, "right"), context) : left;
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
    if (argument.type === "Identifier" && !context.lexicalEnvironment.has(getString(argument, "name"))) {
      return "undefined";
    }
    return guestTypeof(await evaluateExpression(argument, context));
  }

  if (operator === "delete") {
    return (await evaluateReference(getNode(expression, "argument"), context)).delete();
  }

  const value = await evaluateExpression(getNode(expression, "argument"), context);

  switch (operator) {
    case "!":
      return !isTruthy(value);
    case "+":
      return Number(value);
    case "-":
      return -Number(value);
    case "~":
      return ~Number(value);
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

  const calleeReference = calleeNode.type === "MemberExpression"
    ? await evaluateReference(calleeNode, context)
    : undefined;
  const callee = calleeReference === undefined
    ? await evaluateExpression(calleeNode, context)
    : calleeReference.get();
  const thisValue = calleeReference?.kind === "member" ? calleeReference.object : undefined;
  const args = [] as VMInternalValue[];

  for (const argument of getNodeArray(expression, "arguments")) {
    if (argument.type === "SpreadElement") {
      throw unsupportedNode(argument, "Spread arguments are not supported yet.");
    }
    args.push(await evaluateExpression(argument, context));
  }

  if (isHostCallable(callee)) {
    for (let index = 0; index < args.length; index += 1) {
      assertNoCallableReferences(args[index], `$[${index}]`, new WeakSet<object>());
    }

    return importGuestValue(await invokeHostCallable(callee, args), "<capability-result>");
  }

  if (isNativeCallable(callee)) {
    return importGuestValue(
      await invokeNativeCallable(callee, args, context, thisValue, createNativeTools(context)),
      `<${callee.metadata.name}-result>`,
    );
  }

  if (isUserFunction(callee)) {
    return invokeUserFunction(callee, args, context);
  }

  throw runtimeError("Value is not callable in the VM.", {
    reason: "not callable",
    valueType: guestTypeof(callee),
  });
}

async function evaluateNewExpression(
  expression: ASTNode,
  context: VMExecutionContext,
): Promise<VMInternalValue> {
  const callee = await evaluateExpression(getNode(expression, "callee"), context);
  const args = [] as VMInternalValue[];

  for (const argument of getNodeArray(expression, "arguments")) {
    if (argument.type === "SpreadElement") {
      throw unsupportedNode(argument, "Spread constructor arguments are not supported yet.");
    }
    args.push(await evaluateExpression(argument, context));
  }

  if (isNativeCallable(callee) && callee.constructable) {
    return importGuestValue(
      await constructNativeCallable(callee, args, context, createNativeTools(context)),
      `<${callee.metadata.name}-instance>`,
    );
  }

  throw unsupportedNode(expression, "Constructor calls are not supported by the VM interpreter.");
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
      throw unsupportedNode(expression, "Template literals with invalid escapes are not supported.");
    }
    output += cooked;

    if (index < expressions.length) {
      output += String(await evaluateExpression(expressions[index], context));
    }
  }

  return output;
}

async function evaluateReference(node: ASTNode, context: VMExecutionContext): Promise<Reference> {
  if (node.type === "Identifier") {
    return createBindingReference(getString(node, "name"), context);
  }

  if (node.type === "MemberExpression") {
    return createMemberReference(node, context);
  }

  throw unsupportedNode(node, "Only identifiers and member expressions can be assigned or deleted.");
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
      if (context.lexicalEnvironment.has(name)) {
        context.lexicalEnvironment.set(name, value);
      } else {
        context.globalEnvironment.define(name, {
          kind: "var",
          mutable: true,
          deletable: true,
          initialized: true,
          value,
        });
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
): Promise<MemberReference> {
  const objectNode = getNode(node, "object");
  const key = await propertyKeyFromMember(node, context);

  const object = asGuestContainer(await evaluateExpression(objectNode, context));

  return {
    kind: "member",
    object,
    key,
    get() {
      return getGuestProperty(object, key);
    },
    set(value) {
      setGuestProperty(object, key, value);
      return value;
    },
    delete() {
      return deleteGuestProperty(object, key);
    },
  };
}

function getGuestProperty(object: VMObjectContainer, key: string): VMInternalValue {
  if (Array.isArray(object)) {
    if (key === "length") {
      return object.length;
    }
    return isArrayIndex(key) && hasOwn.call(object, key) ? object[Number(key)] : undefined;
  }

  return hasOwn.call(object, key) ? object[key] : undefined;
}

function setGuestProperty(object: VMObjectContainer, key: string, value: VMInternalValue): void {
  if (Array.isArray(object)) {
    if (key === "length") {
      object.length = toArrayLength(value);
      return;
    }

    if (!isArrayIndex(key)) {
      throw securityError("Arrays cannot carry custom properties in the VM.", {
        reason: "array custom property",
        path: key,
      });
    }

    object[Number(key)] = value;
    return;
  }

  object[key] = value;
}

function deleteGuestProperty(object: VMObjectContainer, key: string): boolean {
  if (Array.isArray(object)) {
    if (key === "length") {
      return false;
    }
    delete object[Number(key)];
    return true;
  }

  delete object[key];
  return true;
}

function hasGuestProperty(value: VMInternalValue, key: string): boolean {
  const object = asGuestContainer(value);
  if (Array.isArray(object)) {
    return key === "length" || (isArrayIndex(key) && hasOwn.call(object, key));
  }
  return hasOwn.call(object, key);
}

async function propertyKeyFromMember(node: ASTNode, context: VMExecutionContext): Promise<string> {
  if (node.computed === true) {
    return toPropertyKey(await evaluateExpression(getNode(node, "property"), context));
  }

  const property = getNode(node, "property");
  if (property.type !== "Identifier") {
    throw unsupportedNode(property, "Only identifier member properties are supported.");
  }
  return getString(property, "name");
}

async function propertyKeyFromProperty(node: ASTNode, context: VMExecutionContext): Promise<string> {
  if (node.computed === true) {
    return toPropertyKey(await evaluateExpression(getNode(node, "key"), context));
  }

  const key = getNode(node, "key");
  if (key.type === "Identifier") {
    return getString(key, "name");
  }

  if (key.type === "Literal") {
    return toPropertyKey(key.value);
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
    } else {
      target.define(name, {
        kind: "var",
        mutable: true,
        deletable: true,
        initialized: true,
        value,
      });
    }
  }
}

function createUserFunction(
  node: ASTNode,
  context: VMExecutionContext,
  name: string | undefined,
): VMUserFunction {
  const params = getNodeArray(node, "params").map((param) => {
    if (param.type !== "Identifier") {
      throw unsupportedNode(param, "Only simple identifier function parameters are supported.");
    }
    const paramName = getString(param, "name");
    assertSafeBindingName(paramName);
    return paramName;
  });
  const callable = Object.create(null) as VMUserFunction;

  Object.defineProperties(callable, {
    kind: { enumerable: true, value: "guest-function" },
    name: { enumerable: true, value: name },
    length: { enumerable: true, value: params.length },
  });

  userFunctionRecords.set(callable, {
    name,
    params,
    body: getNode(node, "body"),
    environment: context.lexicalEnvironment,
    expressionBody: node.expression === true || getNode(node, "body").type !== "BlockStatement",
    async: node.async === true,
  });

  return Object.freeze(callable);
}

async function invokeUserFunction(
  callable: VMUserFunction,
  args: readonly VMInternalValue[],
  callerContext: VMExecutionContext,
): Promise<VMInternalValue> {
  const record = userFunctionRecords.get(callable);
  if (record === undefined) {
    throw runtimeError("Unknown guest function.", { reason: "unknown callable" });
  }

  const previousLexical = callerContext.lexicalEnvironment;
  const previousVariable = callerContext.variableEnvironment;
  const functionEnvironment = createLexicalEnvironment(record.environment);

  for (let index = 0; index < record.params.length; index += 1) {
    functionEnvironment.define(record.params[index], {
      kind: "let",
      mutable: true,
      deletable: false,
      initialized: true,
      value: args[index],
    });
  }

  callerContext.lexicalEnvironment = functionEnvironment;
  callerContext.variableEnvironment = functionEnvironment;

  try {
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

    throw runtimeError(`Unexpected ${completion.type} inside guest function.`, {
      reason: `unexpected ${completion.type} completion`,
    });
  } finally {
    callerContext.lexicalEnvironment = previousLexical;
    callerContext.variableEnvironment = previousVariable;
  }
}

function applyAssignmentOperator(
  operator: string,
  left: VMInternalValue,
  right: VMInternalValue,
): VMInternalValue {
  switch (operator) {
    case "+=":
      return (left as number) + (right as number);
    case "-=":
      return Number(left) - Number(right);
    case "*=":
      return Number(left) * Number(right);
    case "/=":
      return Number(left) / Number(right);
    case "%=":
      return Number(left) % Number(right);
    case "**=":
      return Number(left) ** Number(right);
    case "|=":
      return Number(left) | Number(right);
    case "&=":
      return Number(left) & Number(right);
    case "^=":
      return Number(left) ^ Number(right);
    case "<<=":
      return Number(left) << Number(right);
    case ">>=":
      return Number(left) >> Number(right);
    case ">>>=":
      return Number(left) >>> Number(right);
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

function importGuestValue(value: unknown, path: string): VMInternalValue {
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
    return importSerializedGuestValue(
      serializeAndReconstructBoundaryValue(value, { allowCapabilities: false }),
      path,
    );
  }

  if (Array.isArray(value)) {
    const output = createVMArray();
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
      output[index] = descriptor === undefined ? undefined : importGuestValue(readDataDescriptor(descriptor, `${path}[${index}]`), `${path}[${index}]`);
    }
    return output;
  }

  if (isPlainObject(value)) {
    const output = createVMRecord();
    const descriptors = Object.getOwnPropertyDescriptors(value);

    for (const [key, descriptor] of Object.entries(descriptors)) {
      output[key] = importGuestValue(readDataDescriptor(descriptor, `${path}.${key}`), `${path}.${key}`);
    }
    return output;
  }

  return serializeAndReconstructBoundaryValue(value, { allowCapabilities: false });
}

function importSerializedGuestValue(
  value: VMSerializableValue,
  path: string,
): VMInternalValue {
  if (Array.isArray(value)) {
    const output = createVMArray();

    for (let index = 0; index < value.length; index += 1) {
      output[index] = importSerializedGuestValue(value[index], `${path}[${index}]`);
    }

    return output;
  }

  if (isPlainObject(value)) {
    const output = createVMRecord();

    for (const [key, child] of Object.entries(value)) {
      output[key] = importSerializedGuestValue(child, `${path}.${key}`);
    }

    return output;
  }

  return value;
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
      if (
        "value" in descriptor &&
        containsHostCallable(descriptor.value, seen)
      ) {
        return true;
      }
    }

    return false;
  }

  return false;
}

function exportGuestValue(value: VMInternalValue): VMSerializableValue {
  assertNoCallableReferences(value, "$", new WeakSet<object>());
  return serializeAndReconstructBoundaryValue(value, { allowCapabilities: false });
}

function assertNoCallableReferences(
  value: VMInternalValue,
  path: string,
  seen: WeakSet<object>,
): void {
  if (isHostCallable(value) || isNativeCallable(value) || isUserFunction(value)) {
    throw new VMError(
      VMErrorCode.BoundaryUnsupportedType,
      "Guest callables cannot cross the VM boundary as values.",
      { path, valueType: "function" },
    );
  }

  if (typeof value !== "object" || value === null) {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoCallableReferences(value[index], `${path}[${index}]`, seen);
    }
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, VMInternalValue>)) {
    assertNoCallableReferences(child, `${path}.${key}`, seen);
  }
}

function createVMArray(): VMArray {
  const array: VMArray = [];
  vmOwnedObjects.add(array);
  return array;
}

function createVMRecord(): VMRecord {
  const record = Object.create(null) as VMRecord;
  vmOwnedObjects.add(record);
  return record;
}

function asGuestContainer(value: VMInternalValue): VMObjectContainer {
  if (isHostCallable(value) || isNativeCallable(value) || isUserFunction(value)) {
    throw runtimeError("Callable values do not expose VM object properties.", {
      reason: "callable member access",
    });
  }

  if (typeof value === "object" && value !== null && vmOwnedObjects.has(value)) {
    if (Array.isArray(value)) {
      return value;
    }

    if (Object.getPrototypeOf(value) === null) {
      return value as VMRecord;
    }
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
  if (isHostCallable(value) || isNativeCallable(value) || isUserFunction(value)) {
    return "function";
  }

  if (value === null) {
    return "object";
  }

  return typeof value;
}

function isUserFunction(value: unknown): value is VMUserFunction {
  return typeof value === "object" && value !== null && userFunctionRecords.has(value as VMUserFunction);
}

function createNativeTools(context: VMExecutionContext): VMNativeCallableTools {
  return {
    async invokeGuestCallable(callable, args) {
      if (isUserFunction(callable)) {
        return invokeUserFunction(callable, [...args], context);
      }

      if (isNativeCallable(callable)) {
        return invokeNativeCallable(callable, args, context, undefined, createNativeTools(context));
      }

      if (isHostCallable(callable)) {
        for (let index = 0; index < args.length; index += 1) {
          assertNoCallableReferences(args[index], `$[${index}]`, new WeakSet<object>());
        }
        return importGuestValue(await invokeHostCallable(callable, args), "<callback-result>");
      }

      throw runtimeError("Value is not callable in the VM.", {
        reason: "not callable",
        valueType: guestTypeof(callable),
      });
    },
  };
}

function isTruthy(value: VMInternalValue): boolean {
  return Boolean(value);
}

function toPropertyKey(value: VMInternalValue): string {
  if (typeof value === "symbol") {
    throw securityError("Symbols cannot be used as VM property keys.", {
      reason: "symbol property key",
    });
  }
  return String(value);
}

function toArrayLength(value: VMInternalValue): number {
  const length = Number(value);
  if (!Number.isInteger(length) || length < 0 || length > 2 ** 32 - 1) {
    throw runtimeError("Invalid array length.", { reason: "invalid array length" });
  }
  return length;
}

function isArrayIndex(key: string): boolean {
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
    return new VMError(VMErrorCode.VMRuntimeError, error.message, {
      valueType: error.name,
    });
  }

  return new VMError(VMErrorCode.VMRuntimeError, String(error), {
    valueType: typeof error,
  });
}

function runtimeError(message: string, details: Record<string, string | undefined> = {}): VMError {
  return new VMError(VMErrorCode.VMRuntimeError, message, details);
}

function securityError(message: string, details: Record<string, string | undefined> = {}): VMError {
  return new VMError(VMErrorCode.VMSecurityError, message, details);
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
