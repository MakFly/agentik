/**
 * Shell-words tokenizer for the command policy and the `run_command` tool.
 *
 * `run_command` executes ONE argv with no shell: there is no pipe, no `;`, no redirection, no
 * command substitution. A model that wants a pipeline gets a refusal that says so ("one command
 * per call") instead of a silent literal `|` argument, and the policy classifier still sees
 * every segment of a string it did not execute (`bash -c "…"`, `a && b`) because the harness
 * side (B2) classifies commands a foreign CLI ran on its own.
 *
 * An unquoted newline is a separator here exactly like `;` — a shell ends a command on it — and a
 * `\<newline>` is a line continuation that joins the words. Treating `\n` as plain whitespace
 * flattened every multi-line script into one view where no `^`-anchored rule could bite.
 */

export interface ShellToken {
  text: string;
  /** Quoted or escaped somewhere: never an operator, even if it looks like one. */
  quoted: boolean;
  /** Control operator (`&&`, `||`, `|`, `;`, `&`, `\n`, `(`, `)`) or redirection (`>`, `>>`, `<`, `2>&1`). */
  op?: "control" | "redirect";
}

/**
 * An unquoted newline. A shell ends a command on it exactly as it does on `;`, so the policy
 * must see it as a separator: a multi-line `bash -c` body flattened into one view left every
 * `^`-anchored rule (rm -rf /, sudo, mkfs…) unable to bite past the first line.
 */
export const NEWLINE_OP = "\n";

export type ArgvParse =
  | { ok: true; argv: string[] }
  | { ok: false; problem: string };

const CONTROL_OPS = ["&&", "||", "|", ";", "&", "(", ")"];

/**
 * Split a command line the way a POSIX shell lexes it: single quotes literal, double quotes with
 * backslash escapes, unquoted operators as separate tokens. `$(` and backticks are reported as
 * an `op` of kind "control" with their literal text so callers can refuse them by name.
 */
export function shellSplit(input: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let cur = "";
  let quoted = false;
  let has = false;
  const flush = () => {
    if (has) tokens.push({ text: cur, quoted });
    cur = "";
    quoted = false;
    has = false;
  };
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      const stop = end < 0 ? n : end;
      cur += input.slice(i + 1, stop);
      quoted = true;
      has = true;
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && input[j] !== '"') {
        if (input[j] === "\\" && j + 1 < n && '"\\$`'.includes(input[j + 1])) {
          cur += input[j + 1];
          j += 2;
        } else {
          cur += input[j];
          j += 1;
        }
      }
      quoted = true;
      has = true;
      i = j + 1;
      continue;
    }
    // Line continuation `\<newline>`: the two characters vanish and the words join, so
    // `rm -rf \<newline>/` is seen as `rm -rf /` and not as two harmless-looking lines.
    if (c === "\\" && (input[i + 1] === "\n" || input[i + 1] === "\r")) {
      i += input[i + 1] === "\r" && input[i + 2] === "\n" ? 3 : 2;
      continue;
    }
    if (c === "\\" && i + 1 < n) {
      cur += input[i + 1];
      quoted = true;
      has = true;
      i += 2;
      continue;
    }
    // An unquoted newline ends the command, like `;`. Runs are collapsed and a leading one is
    // dropped, so `"ls\n"` and `"\nls"` stay a single plain command.
    if (c === "\n" || c === "\r") {
      flush();
      const last = tokens[tokens.length - 1];
      if (tokens.length && !(last.op === "control" && last.text === NEWLINE_OP)) {
        tokens.push({ text: NEWLINE_OP, quoted: false, op: "control" });
      }
      i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      flush();
      i += 1;
      continue;
    }
    // Command substitution: reported, never executed.
    if (c === "`" || (c === "$" && input[i + 1] === "(")) {
      flush();
      tokens.push({ text: c === "`" ? "`" : "$(", quoted: false, op: "control" });
      i += c === "`" ? 1 : 2;
      continue;
    }
    // Redirections: `>`, `>>`, `<`, `2>`, `2>&1`, `&>`.
    if (c === ">" || c === "<" || (c === "&" && input[i + 1] === ">")) {
      let text = "";
      if (has && !quoted && /^\d+$/.test(cur)) {
        // `2>&1`: the digits we buffered are the fd of this redirection.
        text = cur;
        cur = "";
        has = false;
      }
      flush();
      const m = /^(&>>?|>>|>|<)(&\d+)?/.exec(input.slice(i))!;
      text += m[0];
      tokens.push({ text, quoted: false, op: "redirect" });
      i += m[0].length;
      continue;
    }
    const op = CONTROL_OPS.find((o) => input.startsWith(o, i));
    if (op) {
      flush();
      tokens.push({ text: op, quoted: false, op: "control" });
      i += op.length;
      continue;
    }
    cur += c;
    has = true;
    i += 1;
  }
  flush();
  return tokens;
}

const ONE_COMMAND = "one command per call — pipes, `;`, `&&`, newlines, redirections and `$(…)` are refused; run_command executes a single argv with no shell";

/** `\n` in an error message has to be readable, not an actual line break. */
function opName(text: string): string {
  return text === NEWLINE_OP ? "\\n" : text;
}

/**
 * argv for `run_command`. A string is shell-split; an array is taken as-is. Any operator token
 * (in a string) or literal operator argument (in an array) is refused with a message that names
 * it, because a model asking for `a | b` must learn that the tool has no shell.
 */
export function parseArgv(input: string | string[] | undefined): ArgvParse {
  if (input === undefined) return { ok: false, problem: "empty command" };
  if (Array.isArray(input)) {
    const argv = input.map(String);
    if (argv.length === 0 || argv[0].trim() === "") return { ok: false, problem: "empty command" };
    const bad = argv.find((a) => CONTROL_OPS.includes(a) || /^\d*(>>|>|<)(&\d+)?$/.test(a));
    if (bad !== undefined) return { ok: false, problem: `operator "${bad}" in argv: ${ONE_COMMAND}` };
    return { ok: true, argv };
  }
  const tokens = shellSplit(input);
  // A trailing newline is punctuation, not a second command; anything else is a separator.
  while (tokens.length && tokens[tokens.length - 1].op === "control" && tokens[tokens.length - 1].text === NEWLINE_OP) tokens.pop();
  if (tokens.length === 0) return { ok: false, problem: "empty command" };
  const op = tokens.find((t) => t.op);
  if (op) return { ok: false, problem: `operator "${opName(op.text)}": ${ONE_COMMAND}` };
  return { ok: true, argv: tokens.map((t) => t.text) };
}
