// dsh:logging-exempt (shim layer)
/**
 * shims/util-parse-args.js — node:util's parseArgs, split out of util.js
 * when that file crossed the code-size budget. One-way dependency: nothing
 * here imports util.js; util.js re-exports the face so bare-importers keep
 * their specifier.
 */

/** One `--long` arg (module level for size): name/negation/inline-value
 * split, strict declaration check, value resolution, token record. Returns
 * the (possibly advanced) arg index. */
const parseLongOption = (ctx) => {
  const { args, i, arg, options, strict, declared, wantsValue, values, tokens } = ctx;
  const body = arg.slice(2);
  const eq = body.indexOf('=');
  const longName = eq === -1 ? body : body.slice(0, eq);
  const negated = longName.startsWith('no-');
  const bare = negated ? longName.slice(3) : longName;
  const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);
  if (strict && !declared(bare)) {
    // node's capital-U contract (llm-mock-server CLI tests match the exact text)
    throw new Error(`Unknown option '--${longName}'`);
  }
  let at = i;
  if (inlineValue !== undefined) {
    values[bare] = inlineValue;
  } else if (wantsValue(bare)) {
    if (at + 1 >= args.length) {
      // node's missing-argument contract (strict mode)
      throw new Error(`Option '--${bare} <value>' argument missing`);
    }
    at += 1;
    values[bare] = args[at];
  } else {
    values[bare] = !negated;
  }
  if (tokens !== undefined) {
    tokens.push({ kind: 'option', name: longName, rawName: arg, index: at,
      value: values[bare], inlineValue });
  }
  return at;
};

/** One short cluster (-ab / -ovalue): map each letter through its `short`
 * alias, strict declaration check, value consumption, token record. Returns
 * the (possibly advanced) arg index. */
const parseShortCluster = (ctx) => {
  const { args, i, arg, options, strict, declared, wantsValue, values, tokens } = ctx;
  const cluster = arg.slice(1);
  for (let k = 0; k < cluster.length; k++) {
    const shortName = cluster[k];
    const longFor = Object.keys(options).find((name) => options[name]?.short === `-${shortName}`);
    const name = longFor ?? shortName;
    const rest = cluster.slice(k + 1);
    if (strict && !declared(name)) {
      throw new Error(`Unknown option '-${shortName}'`);
    }
    if (rest.length > 0 && wantsValue(name)) {
      values[name] = rest;
      if (tokens !== undefined) tokens.push({ kind: 'option', name, rawName: `-${shortName}${rest}`, index: i, value: rest });
      break;
    }
    if (wantsValue(name)) {
      if (i + 1 >= args.length) {
        // node reports the LONG spelling when the short maps to one
        throw new Error(`Option '--${declared(name) ? name : shortName} <value>' argument missing`);
      }
      values[name] = args[i + 1];
      if (tokens !== undefined) tokens.push({ kind: 'option', name, rawName: `-${shortName}`, index: i + 1, value: values[name] });
      return i + 1;
    }
    values[name] = true;
    if (tokens !== undefined) tokens.push({ kind: 'option', name, rawName: `-${shortName}`, index: i });
  }
  return i;
};

/** The wantsValue classifier (module level for size): string options want a
 * value, boolean options don't, undeclared ones only accept `--x=v`. */
const optionWantsValue = (options, longName, kind) => {
  const option = options[longName];
  const type = typeof option === 'string' ? option : option?.type;
  if (type === 'string') return true;
  if (type === 'boolean') return false;
  if (type === undefined) return kind === 'inline'; // undeclared: value only when --x=v
  throw new TypeError(`util.parseArgs: option '${longName}' has invalid type ${String(type)}`);
};

/** parseArgs({ args, options, strict, allowPositionals, tokens }) — the
 * config subset the suite's CLI parsers drive: long options (--name=value /
 * --name value), short option clusters (-abc), negation (--no-name), and
 * positional collection. strict:false tolerates unknown options (they land
 * in `values` anyway); strict:true throws on undeclared ones like node. */
export const parseArgs = (config = {}) => {
  const args = config.args ?? (typeof globalThis.process?.argv !== 'undefined' ? globalThis.process.argv.slice(2) : []);
  const options = config.options ?? {};
  const strict = config.strict === true;
  const declared = (longName) => Object.prototype.hasOwnProperty.call(options, longName);
  const wantsValue = (longName, kind) => optionWantsValue(options, longName, kind);
  const values = {};
  const positionals = [];
  const tokens = config.tokens === true ? [] : undefined;
  let onlyPositionals = false; // after `--`, everything is positional
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (tokens !== undefined) tokens.push({ kind: 'positional', value: arg, index: i });
    if (onlyPositionals || arg === '-' || !arg.startsWith('-')) {
      if (config.allowPositionals !== true) {
        // node's 22+ contract: strict parse of a positional without
        // allowPositionals is `Unexpected argument '<arg>'` (the
        // llm-mock-server CLI tests match that text).
        throw new Error(`Unexpected argument '${arg}'`);
      }
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      onlyPositionals = true;
      continue;
    }
    if (arg.startsWith('--')) {
      i = parseLongOption({ args, i, arg, options, strict, declared, wantsValue, values, tokens });
      continue;
    }
    // short cluster: -ab or -ovalue
    i = parseShortCluster({ args, i, arg, options, strict, declared, wantsValue, values, tokens });
  }
  // Defaults: declared boolean options absent from args default false,
  // string options undefined (node's config-defaults contract).
  for (const [name, option] of Object.entries(options)) {
    const type = typeof option === 'string' ? option : option?.type;
    if (values[name] === undefined && type === 'boolean') values[name] = false;
    if (option?.default !== undefined && values[name] === undefined) values[name] = option.default;
  }
  const result = { values, positionals };
  if (tokens !== undefined) result.tokens = tokens;
  return result;
};

