import {
  parse as parseWithAcorn,
  type Options as AcornOptions,
  type Position,
  type Program,
} from "acorn";

import { VMError, VMErrorCode } from "./boundary";

export type VMParserSourceType = "script" | "module";

export interface VMParserOptions {
  /**
   * VM evaluation starts from script parsing because scripts match classic
   * global-program semantics. Module parsing is explicit so imports,
   * exports, and module strictness can be handled by the interpreter layer.
   */
  readonly sourceType?: VMParserSourceType;
  readonly sourceFile?: string;
}

export type VMProgram = Program;

interface AcornParseError extends SyntaxError {
  readonly pos?: number;
  readonly loc?: Position;
  readonly raisedAt?: number;
}

const DEFAULT_SOURCE_TYPE: VMParserSourceType = "script";

export function parseProgram(source: string, options: VMParserOptions = {}): VMProgram {
  if (typeof source !== "string") {
    throw new VMError(VMErrorCode.VMSyntaxError, "VM source must be a string.", {
      valueType: typeof source,
    });
  }

  const parseOptions: AcornOptions = {
    ecmaVersion: "latest",
    sourceType: options.sourceType ?? DEFAULT_SOURCE_TYPE,
    locations: true,
    ranges: true,
    allowHashBang: true,
  };

  if (options.sourceFile !== undefined) {
    parseOptions.sourceFile = options.sourceFile;
  }

  try {
    return parseWithAcorn(source, parseOptions);
  } catch (error) {
    throw normalizeParseError(error);
  }
}

function normalizeParseError(error: unknown): VMError {
  if (error instanceof VMError) {
    return error;
  }

  const parseError = error as Partial<AcornParseError>;
  const message =
    typeof parseError.message === "string" && parseError.message.length > 0
      ? parseError.message
      : "Unable to parse VM source.";

  return new VMError(VMErrorCode.VMSyntaxError, message, {
    reason: formatParseErrorReason(parseError),
  });
}

function formatParseErrorReason(error: Partial<AcornParseError>): string {
  const parts: string[] = ["parser rejected source"];

  if (typeof error.pos === "number") {
    parts.push(`position ${error.pos}`);
  }

  if (error.loc !== undefined) {
    parts.push(`line ${error.loc.line}, column ${error.loc.column}`);
  }

  if (typeof error.raisedAt === "number" && error.raisedAt !== error.pos) {
    parts.push(`raised at ${error.raisedAt}`);
  }

  return parts.join("; ");
}
