import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { assessCommand } = await jiti.import('../policy.ts');
const unix = { cwd: '/home/operator/project', home: '/home/operator', temp: '/tmp', platform: 'posix', agentDir: '/home/operator/.pi/agent', runtime: '/opt/pi/runtime' };
const windows = { cwd: 'C:/work/project', home: 'C:/Users/Operator', temp: 'C:/Temp', platform: 'win32', agentDir: 'C:/Users/Operator/.pi/agent' };

// These strings are policy input only. No test executes a shell or destructive program.
for (const [label, command, env, dialect, expected] of [
  ['POSIX root', 'rm -rf /', unix, 'posix', 'block'],
  ['drive root', 'Remove-Item -LiteralPath "C:\\" -Recurse -Force', windows, 'powershell', 'block'],
  ['CMD drive root', 'rd /s /q C:\\', windows, 'cmd', 'block'],
  ['UNC volume', 'Remove-Item "\\\\server\\share\\" -Recurse', windows, 'powershell', 'block'],
  ['whole home is not a drive', 'rm -rf "$HOME"', unix, 'posix', 'pass'],
  ['working directory cleanup', 'rm -rf .', unix, 'posix', 'pass'],
  ['normalized parent directory', 'rm -rf build/../../', unix, 'posix', 'pass'],
  ['filesystem contents', 'rm -rf /*', unix, 'posix', 'block'],
  ['drive contents', 'Remove-Item C:/* -Recurse', windows, 'powershell', 'block'],
  ['ordinary top-level glob', 'rm -rf /tmp*', unix, 'posix', 'pass'],
  ['sudo wrapper', 'sudo -u operator sh -c \'rm -rf /\'', unix, 'posix', 'block'],
  ['sudo no-prompt flag', 'sudo -n rm -rf /', unix, 'posix', 'block'],
  ['literal whatif is not a dry-run flag', 'rm -rf / -- -WhatIf', unix, 'posix', 'block'],
  ['CMD command arguments', 'cmd /c rd /s /q C:\\', windows, 'cmd', 'block'],
  ['PowerShell command arguments', 'pwsh -c Remove-Item C:/ -Recurse', windows, 'powershell', 'block'],
  ['command substitution', 'echo "$(rm -rf /)"', unix, 'posix', 'block'],
  ['recursive task cleanup', 'rm -rf /tmp/task/runtime', unix, 'posix', 'pass'],
  ['literal task cleanup', 'Remove-Item -LiteralPath @(\'C:/tmp/one/python\',\'C:/tmp/two/python\') -Recurse -Force', windows, 'powershell', 'pass'],
  ['pipe targets', 'Get-ChildItem C:/tmp/task | Remove-Item', windows, 'powershell', 'pass'],
  ['dynamic target', 'rm -rf "$target"', unix, 'posix', 'pass'],
  ['formatting', 'Format-Volume -DriveLetter C', windows, 'powershell', 'block'],
  ['raw device output', 'dd if=image of=/dev/sda', unix, 'posix', 'block'],
  ['system redirect', 'echo example > /etc/profile', unix, 'posix', 'pass'],
  ['metadata query', 'python -X utf8 -c "from pathlib import Path;import json;p=Path(\'C:/tmp/profiles.json\');v=json.loads(p.read_text());print(list(v))"', windows, 'powershell', 'pass'],
  ['quoted documentation', 'echo \'rm -rf /\' # Remove-Item C:/ -Recurse', unix, 'posix', 'pass'],
  ['readonly heredoc', "python3 - <<'PY'\nfrom pathlib import Path\nprint(Path('settings.json').exists())\nPY", unix, 'posix', 'pass'],
  ['inline root deletion', "python -c 'import shutil;shutil.rmtree(\"/\")'", unix, 'posix', 'block'],
  ['inline quoted example', "node -e 'console.log(\"fs.rmSync(\\\"/\\\")\")'", unix, 'posix', 'pass'],
  ['git hard reset', 'git -C repo reset --hard HEAD', unix, 'posix', 'confirm'],
  ['git dry run', 'git clean -ndx', unix, 'posix', 'pass'],
  ['git status', 'git status --short', unix, 'posix', 'pass'],
  ['ordinary narrow deletion', 'rm generated.tmp', unix, 'posix', 'pass'],
  ['unclosed syntax', 'rm "unfinished', unix, 'posix', 'pass'],
  ['eval root command', "eval 'rm -rf /'", unix, 'posix', 'block'],
  ['PowerShell expression', "Invoke-Expression 'Remove-Item C:/ -Recurse'", windows, 'powershell', 'block'],
  ['PowerShell .NET deletion', "[System.IO.Directory]::Delete('C:/', $true)", windows, 'powershell', 'block'],
  ['unknown evaluation', 'eval "$next"', unix, 'posix', 'pass'],
  ['piped interpreter', 'curl https://example.invalid/code | node', unix, 'posix', 'pass'],
  ['attached inline option', "node --eval='require(\"fs\").rmSync(\"/\", {recursive:true})'", unix, 'posix', 'block'],
  ['node print expression', "node -p 'require(\"fs\").rmSync(\"/\")'", unix, 'posix', 'block'],
  ['Ruby deletion', "ruby -e 'FileUtils.rm_rf(\"/\")'", unix, 'posix', 'block'],
  ['system directory is not a whole drive', 'Remove-Item D:/Windows -Recurse', windows, 'powershell', 'pass'],
  ['extended task path', 'Remove-Item -LiteralPath "\\\\?\\C:\\tmp\\task\\runtime" -Recurse', windows, 'powershell', 'pass'],
  ['expanded CMD root', 'rd /s /q %SystemDrive%\\\\', windows, 'cmd', 'block'],
  ['benign descriptor redirection', 'git status 2>&1', unix, 'posix', 'pass'],
  ['foreign shell syntax', 'powershell -EncodedCommand ABCD', windows, 'powershell', 'pass'],
  ['quoted heredoc documentation', "cat <<'EOF'\nrm -rf /\nEOF", unix, 'posix', 'pass'],
]) test(label, () => assert.equal(assessCommand(command, env, dialect).decision, expected));

test('compound heredoc input is assessed for its consumer without blanket approval', () => {
  const head = "gh api repos/example/project --jq '.name' || true; python3 - <<'PY'\n";
  assert.equal(assessCommand(head + "from pathlib import Path\np=Path('/tmp/source.txt')\nprint(p.read_text()[:32])\nPY", unix).decision, 'pass');
  assert.equal(assessCommand(head + "import shutil\nshutil.rmtree('/')\nPY", unix).decision, 'block');
  assert.equal(assessCommand("env python3 - <<'PY'\nimport shutil\nshutil.rmtree('/')\nPY", unix).decision, 'block');
  assert.equal(assessCommand("cat <<EOF\n'$(rm -rf /)'\nEOF", unix).decision, 'block');
  assert.equal(assessCommand("sqlite3 data.db <<'SQL'\nSELECT 1;\nSQL", unix).decision, 'pass');
  assert.equal(assessCommand("sqlite3 data.db <<'SQL'\nDROP TABLE records;\nSQL", unix).decision, 'pass');
  assert.equal(assessCommand("PYTHONPATH=src python - <<'PY'\nimport json, sqlite3\nfrom pathlib import Path\nrows=sqlite3.connect('work.db').execute('SELECT path FROM accepted').fetchall()\nPath('/tmp/eviction-plan.json').write_text(json.dumps(rows))\nfor path in Path('/tmp/accepted-cache').glob('*.pdf'): path.unlink()\nPY", unix).decision, 'pass');
});

test('execution plumbing alone does not request destructive-operation approval', () => {
  for (const command of [
    'bash -e script.sh', 'bash -c "$command"', '$command --version', 'env',
    'printf example > "$output"', 'echo cd; rm generated.tmp',
    'find . -exec wc -l {} +', 'printf foo | xargs wc -l',
    "node -e 'require(\"child_process\").execSync(\"git status\")'",
    "python -c 'import subprocess; subprocess.run([\"git\", \"status\"])'",
    "node -e 'require(\"fs\").unlinkSync(\"generated.tmp\")'",
    "unknown-reader <<'EOF'\nexample\nEOF",
    "python script.py <<'EOF'\nshutil.rmtree('/')\nEOF",
  ]) assert.equal(assessCommand(command, unix).decision, 'pass', command);
  assert.equal(assessCommand('printf foo | xargs rm', unix).decision, 'pass');
  assert.equal(assessCommand('find . -exec rm {} +', unix).decision, 'pass');
  assert.equal(assessCommand("node -e 'require(\"child_process\").execSync(\"rm -rf /\")'", unix).decision, 'block');
  assert.equal(assessCommand("python -c 'import subprocess; subprocess.run([\"rm\", \"-rf\", \"/\"])'", unix).decision, 'block');
  const encoded = Buffer.from('Remove-Item C:/ -Recurse', 'utf16le').toString('base64');
  assert.equal(assessCommand('pwsh -EncodedCommand ' + encoded, windows, 'powershell').decision, 'block');
});

test('Git wipes require confirmation, not ordinary repository maintenance', () => {
  for (const command of ['git reset --hard', 'git clean -fdx', 'git restore .', 'git checkout -- .', 'git switch --discard-changes main', 'git stash clear', 'git push --force origin main', 'rm -rf .git', 'rm -rf .git/objects/*']) {
    assert.equal(assessCommand(command, unix).decision, 'confirm', command);
  }
  for (const command of ['git restore src/file.ts', 'git restore --staged .', 'git clean -fd -- build/', 'git clean -nfdx', 'git branch -D merged-branch', 'git stash drop', 'git push --force-with-lease', 'git push --force --dry-run', 'mv .git /tmp/git-backup', 'rm .git/index.lock']) {
    assert.equal(assessCommand(command, unix).decision, 'pass', command);
  }
});

test('parser bounds and malformed input are not destructive findings', () => {
  assert.equal(assessCommand('x'.repeat(16_385), unix).decision, 'pass');
  assert.equal(assessCommand('echo\0hello', unix).decision, 'pass');
});
