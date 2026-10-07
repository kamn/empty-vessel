import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ActionGuard, type Action } from "empty-vessel"
import { noAbsoluteRm, noAbsoluteRmPolicy } from "../../src/plugins/no-absolute-rm"

// All shell snippets are data only. No child processes or filesystem deletion.
const allowed = [
  "rm -rf folder", "rm ./folder -rf", "rm ../folder", "rm -f a b -r c", "rm -- -folder",
  "rm './two words'", 'rm "relative path"', "rm relative\\ path",
  "rm '$DIR'", "rm '~folder'", "rm '{one,two}'", "rm \\$DIR", "rm \\~folder",
  "/bin/rm -rf ./tmp", "/usr/bin/rm -- relative", "r\\m -f relative", "'rm' relative",
  "sudo rm -rf relative", "sudo -n -u root -- /bin/rm relative", "command -p -- rm ./a",
  "env -i MODE=test rm a", "MODE=test rm a", "sudo env MODE=test command rm a",
  "echo 'rm -rf /tmp/folder'", 'echo "rm -rf /tmp/folder"', "echo rm -rf /tmp/folder",
  "cat /tmp/file", "printf '%s' 'rm /tmp/file'", "rmdir ./folder", "rm-lookalike /tmp/file",
  "echo ok && rm a || rm b; cat /tmp/file\nrm c | cat", "rm a # rm /tmp/not-executed",
  "rm rel\\\native", "rm '>' '<' '(' ')'", "", "# rm /tmp/not-executed",
]

const denied = [
  "rm -rf /tmp/folder", "rm -f /tmp/file", "rm /tmp/file", "rm /", "rm //tmp/file",
  "rm relative /tmp/file relative2", "rm /tmp/file -rf", "rm -r relative -f /tmp/file",
  "rm -- /tmp/file", "rm -- -f /tmp/file", "rm -rf '/tmp/two words'", 'rm -f "/tmp/file"',
  "rm \\/tmp/file", "rm /tmp/two\\ words", "rm '/'tmp/file", "r\\m /tmp/file",
  "/bin/rm -rf /tmp/file", "/usr/bin/rm /tmp/file", "'/bin/rm' /tmp/file",
  "sudo rm /tmp/file", "sudo -n -u root -- rm /tmp/file", "command -- rm /tmp/file",
  "env MODE=test rm /tmp/file", "sudo env -i command /bin/rm /tmp/file",
  "rm /tmp/$DIR", "rm --unknown /tmp/file", "rm /tmp/file > log",
  "cat < /tmp/file; rm /tmp/target", "echo 'safe; rm /tmp/unused'; rm /tmp/target",
  ...["&&", "||", ";", "\n", "|"].flatMap((separator) => [
    `echo ok ${separator} rm -f /tmp/file`, `rm /tmp/file ${separator} echo ok`,
    `rm $DIR ${separator} rm /tmp/file`,
  ]),
]

const revised = [
  "rm $DIR", 'rm "$DIR"', "rm ${DIR}/file", "rm $(pwd)/file", "rm `pwd`/file",
  "rm ~", "rm ~/file", "rm {a,b}", "rm *.txt", "rm file?", "rm [ab]",
  "rm $'\\x2ftmp/file'", 'rm $"/tmp/file"', "rm --unknown relative", "rm -xyz relative",
  "rm --interactive=never relative", "rm 'unterminated", 'rm "unterminated', "rm trailing\\",
  "sudo -S rm relative", "sudo -u $USER rm relative", "command -v rm", "env -S 'rm /tmp/file'",
  "env --chdir=/tmp rm relative", "busybox rm /tmp/file", "xargs rm", "./rm relative", "/custom/rm relative",
  "sh -c 'rm /tmp/file'", "bash script.sh", "eval 'rm /tmp/file'", "exec rm relative", "nice rm relative",
  "find . -exec rm {} \\;", "if true; then rm relative; fi", "(rm relative)", "{ rm relative; }",
  "rm relative > /tmp/log", "rm relative 2>/tmp/log", "rm >/tmp/log /tmp/file", "cat < /tmp/file", "cat <<EOF\nrm relative\nEOF",
  "echo $(rm /tmp/file)", 'echo "$(rm /tmp/file)"', "echo `rm /tmp/file`",
  "cat <(rm relative)", "rm relative &", "$COMMAND relative", "rm relative\nsource script.sh",
]

describe("no-absolute-rm literal policy", () => {
  for (const [decision, commands] of [["allow", allowed], ["deny", denied], ["revise", revised]] as const) {
    for (const command of commands) {
      test(`${decision}: ${JSON.stringify(command)}`, () => {
        const verdict = noAbsoluteRmPolicy(command)
        expect(verdict.decision).toBe(decision)
        if (verdict.decision !== "allow") expect(verdict.reason).toContain("relative")
      })
    }
  }

  test("plugin provides the pure policy through beforeAction without execution", () => Effect.runPromise(Effect.gen(function* () {
    expect(noAbsoluteRm.name).toBe("no-absolute-rm")
    const layer = yield* noAbsoluteRm.provides.actionGuard!
    const action: Action = { kind: "shell", command: "rm -rf /tmp/folder", cwd: "/anywhere", timeoutMs: 10 }
    const verdict = yield* Effect.gen(function* () {
      const guard = yield* ActionGuard
      return yield* guard.beforeAction(action)
    }).pipe(Effect.provide(layer))
    expect(verdict).toEqual(noAbsoluteRmPolicy(action.command))
  })))
})
