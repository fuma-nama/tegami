import { parseArgs, ParseArgsOptionDescriptor, type ParseArgsOptionsConfig } from "node:util";
import type { TegamiContext } from "../context";
import type { Awaitable } from "../types";
import type { Tegami } from "..";

type ArgValue = boolean | string | string[] | boolean[];
type PositionalValue = string | string[];
export interface TegamiCliCommand<
  Values extends Record<string, ArgValue | undefined>,
  Positionals extends Record<string, PositionalValue | undefined>,
> {
  option<
    const Name extends string,
    const T extends "string" | "boolean",
    const Multiple extends boolean = false,
  >(
    name: Name,
    opts: {
      type: T;
      short?: string;
      description?: string;
      multiple?: Multiple;
    },
  ): TegamiCliCommand<
    Values & {
      [k in Name]?: Multiple extends true
        ? T extends "string"
          ? string[]
          : boolean[]
        : T extends "string"
          ? string
          : boolean;
    },
    Positionals
  >;

  positional<const Name extends string, const Required extends boolean = true>(
    name: Name,
    required?: Required,
  ): TegamiCliCommand<
    Values,
    Positionals & {
      [K in Name]: Required extends true ? string : string | undefined;
    }
  >;

  positionals<const Name extends string>(
    name: Name,
  ): TegamiCliCommand<
    Values,
    Positionals & {
      [K in Name]: string[];
    }
  >;

  action(
    fn: (options: {
      context: TegamiContext;
      values: Values;
      positionals: Positionals;
    }) => Awaitable<void>,
  ): void;
}

export interface TegamiCliRegistry {
  command(
    path: string,
    options?: {
      description?: string;
      /**
       * If the package graph must be resolved to run this action.
       *
       * @default true
       */
      resolve?: boolean;
    },
  ): TegamiCliCommand<Record<never, never>, Record<never, never>>;
  help(): string;
  parse(argv: string[]): Promise<void>;
}

interface CommandDefinition {
  path: string[];
  description?: string;
  options: OptionDefinition[];
  positionals: PositionalDefinition[];
  resolve: boolean;
  action?: (options: {
    context: TegamiContext;
    values: Record<string, ArgValue | undefined>;
    positionals: Record<string, PositionalValue | undefined>;
  }) => Awaitable<void>;
}

interface OptionDefinition {
  name: string;
  short?: string;
  description?: string;
  type: "boolean" | "string";
  multiple?: boolean;
}

interface PositionalDefinition {
  name: string;
  required: boolean;
  multiple?: boolean;
}

export function createTegamiCliRegistry(tegami: Tegami): TegamiCliRegistry {
  const commands = new Map<string, CommandDefinition>();

  function getChildCommands(command: CommandDefinition): CommandDefinition[] {
    const out: CommandDefinition[] = [];
    const prefix = command.path.join("\0");
    for (const [key, candidate] of commands) {
      if (key.startsWith(prefix) && key.length > prefix.length) out.push(candidate);
    }
    return out;
  }

  return {
    command(path, options) {
      const definition: CommandDefinition = {
        path: path.length === 0 ? [] : path.split(/\s+/),
        positionals: [],
        description: options?.description,
        options: [],
        resolve: options?.resolve ?? true,
      };
      commands.set(definition.path.join("\0"), definition);

      const api: TegamiCliCommand<Record<never, never>, Record<never, never>> = {
        option(name, { short, description = "", type, multiple }) {
          definition.options.push({
            name,
            short,
            type,
            multiple,
            description,
          });
          return api as never;
        },
        positional(name, required) {
          definition.positionals.push({
            name,
            required: required ?? true,
          });
          return api as never;
        },
        positionals(name) {
          definition.positionals.push({
            name,
            required: false,
            multiple: true,
          });
          return api as never;
        },
        action(fn) {
          definition.action = fn;
        },
      };

      return api;
    },
    help: () => formatRootHelp(commands),
    async parse(argv) {
      if (argv[0] === "--help" || argv[0] === "-h") {
        console.log(formatRootHelp(commands));
        return;
      }

      const match = findCommand(commands, argv);
      if (!match) {
        throw new Error(`Unknown command: ${argv[0]}`);
      }

      const args = argv.slice(match.path.length);
      if (args.includes("--help") || args.includes("-h")) {
        console.log(formatCommandHelp(match, getChildCommands(match)));
        return;
      }

      if (!match.action) {
        if (args.length === 0) {
          console.log(formatCommandHelp(match, getChildCommands(match)));
          return;
        }

        throw new Error(`Unknown command: ${argv.slice(0, match.path.length + 1).join(" ")}`);
      }

      const { values, positionals } = parseCommandArgs(match, args);
      const context = match.resolve
        ? await tegami._internal.context()
        : await tegami._internal.contextUnresolved();
      await match.action({ context, values, positionals });
    },
  };
}

function formatUsage(command: CommandDefinition): string {
  const s: string[] = [...command.path];
  for (const positional of command.positionals) {
    let c = positional.multiple ? `...${positional.name}` : positional.name;
    s.push(positional.required ? `<${c}>` : `[${c}]`);
  }
  return s.join(" ");
}

function findCommand(
  commands: Map<string, CommandDefinition>,
  argv: string[],
): CommandDefinition | undefined {
  if (argv.length === 0) {
    return commands.get("");
  }

  for (let i = 0; i < argv.length; i++) {
    const search = argv.slice(0, argv.length - i).join("\0");
    const res = commands.get(search);
    if (res) return res;
  }
}

function parseCommandArgs(
  command: CommandDefinition,
  args: string[],
): {
  values: Record<string, ArgValue | undefined>;
  positionals: Record<string, PositionalValue | undefined>;
} {
  const optionsConfig: ParseArgsOptionsConfig = {
    help: { type: "boolean", short: "h" },
  };
  for (const option of command.options) {
    const config: ParseArgsOptionDescriptor = (optionsConfig[option.name] = {
      type: option.type,
    });
    if (option.short) config.short = option.short;
    if (option.multiple) config.multiple = true;
  }

  const parsed = parseArgs({
    args,
    options: optionsConfig,
    strict: true,
    allowPositionals: command.positionals.length > 0,
  });
  const positionals: Record<string, PositionalValue> = {};

  for (const positional of command.positionals) {
    if (positional.multiple) {
      const value: string[] = (positionals[positional.name] = []);
      while (parsed.positionals.length > 0) {
        value.push(parsed.positionals.shift()!);
      }
      continue;
    }

    const value = parsed.positionals.shift();
    if (value === undefined && positional.required)
      throw new Error(`missing required argument: ${positional.name}`);
    if (value === undefined) continue;

    positionals[positional.name] = value;
  }

  if (parsed.positionals.length > 0) {
    throw new Error("Too many arguments");
  }

  return {
    values: parsed.values as never,
    positionals,
  };
}

function formatRootHelp(commands: Map<string, CommandDefinition>): string {
  let width = 0;
  const rows: [string, string][] = [];
  for (const command of commands.values()) {
    if (command.path.length === 0) continue;

    const key = formatUsage(command);
    width = Math.max(width, key.length);
    rows.push([key, command.description ?? ""]);
  }

  const lines: string[] = [
    "Usage: tegami [command]",
    "",
    commands.get("")?.description ?? "create changelogs",
    "",
    "Commands:",
    ...rows.map(([usage, description]) => `  ${usage.padEnd(width)}   ${description}`),
    "",
    "Run without a command to open the changelog TUI.",
  ];

  return `${lines.join("\n")}\n`;
}

function formatCommandHelp(command: CommandDefinition, childCommands: CommandDefinition[]): string {
  let width = 0;
  let childWidth = 0;
  const optionRows = command.options.map<[string, string]>((option) => {
    const short = option.short ? `-${option.short}, ` : "";
    const long = `--${option.name}`;
    const key = option.type === "string" ? `${short}${long} <value>` : `${short}${long}`;

    width = Math.max(width, key.length);
    return [key, option.description ?? ""];
  });
  const childRows = childCommands.map<[string, string]>((child) => {
    const key = formatUsage(child);

    childWidth = Math.max(childWidth, key.length);
    return [key, child.description ?? ""];
  });

  const lines: string[] = [];
  if (command.action) lines.push(`Usage: ${formatUsage(command)}`, "");
  if (command.description) lines.push(command.description, "");

  if (optionRows.length > 0) {
    lines.push("Options:");
    for (const [flags, description] of optionRows) {
      lines.push(`  ${flags.padEnd(width)}   ${description}`);
    }
    lines.push("");
  }

  if (childRows.length > 0) {
    lines.push("Commands:");
    for (const [usage, description] of childRows) {
      lines.push(`  ${usage.padEnd(childWidth)}   ${description}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
