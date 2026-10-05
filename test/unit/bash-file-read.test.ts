import { describe, it, expect } from 'bun:test';
import { detectBashFileRead, isBashFileRead } from '../../lib/bash-file-read';

describe('detectBashFileRead — file reads (blocked)', () => {
  const blocked = [
    'cat file.txt',
    'head -20 file.txt',
    'head -n 20 config.json',
    'tail file.txt',
    'tail -f /var/log/system.log',
    'cd /tmp; cat file.txt',
    'ls; head -n 50 config.json',
    'echo done; tail -20 log.txt',
    'cd /tmp && cat file.txt',
    'ls && head file.txt',
    'ls -la | cat file.txt',
    'cat file.txt | grep foo',
    'cat a.txt | head -5',
  ];

  for (const cmd of blocked) {
    it(`flags: ${cmd}`, () => {
      expect(isBashFileRead(cmd)).toBe(true);
      expect(detectBashFileRead(cmd)).toBeTruthy();
    });
  }
});

describe('detectBashFileRead — stdin filters and clean commands (allowed)', () => {
  const allowed = [
    'grep foo bar.txt | head -20',
    'grep foo bar.txt | tail -5',
    'grep foo bar.txt | cat',
    'bun test | tail -30',
    'git log --oneline | head -n 50',
    'find . -name "*.ts" | grep test | head',
    'find . -name "*.ts" | grep test | tail -20',
    'ls | head -n 20',
    'grep -r "pattern" src/',
    'ls -la /tmp',
    'echo "test" | wc -l',
    'bun test test/unit/foo.test.ts',
    'git commit -m "docs: explain grep | head -80 blocking"',
    // Redirections write; they are not file operands.
    "cat > /tmp/msg.txt <<'EOF'\nhello\nEOF",
    'cat >/tmp/msg.txt',
    'cat >> /tmp/log.txt',
    'bun test | tail -30 > /tmp/out.txt',
    'bun test 2>&1 | tail -20',
    'echo hi | cat > out.txt',
  ];

  for (const cmd of allowed) {
    it(`allows: ${cmd}`, () => {
      expect(isBashFileRead(cmd)).toBe(false);
      expect(detectBashFileRead(cmd)).toBeNull();
    });
  }
});

describe('detectBashFileRead — operator and flag parsing', () => {
  it('still blocks input redirection — that really does read a file', () => {
    expect(isBashFileRead('cat < package.json')).toBe(true);
    expect(isBashFileRead('cat </etc/hosts')).toBe(true);
  });

  it('blocks a real operand even alongside an output redirect', () => {
    expect(isBashFileRead('cat package.json > /tmp/copy.json')).toBe(true);
    expect(isBashFileRead('head -20 src/index.ts >> /tmp/log')).toBe(true);
  });

  it('treats || as one operator, not two pipes', () => {
    expect(isBashFileRead('test -f x || head -5')).toBe(false);
    expect(isBashFileRead('test -f x || cat x')).toBe(true);
  });

  it('does not treat -n value as a file operand', () => {
    expect(isBashFileRead('ls | head -n 20')).toBe(false);
    expect(isBashFileRead('ls | head -c 100')).toBe(false);
  });

  it('does not treat short numeric flags as operands', () => {
    expect(isBashFileRead('ls | tail -30')).toBe(false);
    expect(isBashFileRead('ls | head -n20')).toBe(false);
  });

  it('does not treat long flags as operands', () => {
    expect(isBashFileRead('ls | head --lines=20')).toBe(false);
    expect(isBashFileRead('ls | head --lines 20')).toBe(false);
  });

  it('returns the offending segment', () => {
    expect(detectBashFileRead('ls && head -20 notes.md')).toBe('head -20 notes.md');
  });

  it('ignores cat/head/tail appearing as arguments, not commands', () => {
    expect(isBashFileRead('grep cat animals.txt')).toBe(false);
    expect(isBashFileRead('echo "cat file.txt"')).toBe(false);
  });

  it('does not split on operators inside double quotes', () => {
    expect(isBashFileRead('git commit -m "explain grep | head -80"')).toBe(false);
    expect(isBashFileRead('git commit -m "fix; cat notes.md"')).toBe(false);
    expect(isBashFileRead('echo "a && cat b.txt"')).toBe(false);
  });

  it('does not split on operators inside single quotes', () => {
    expect(isBashFileRead("git commit -m 'explain grep | head -80'")).toBe(false);
    expect(isBashFileRead("echo 'tail -f /var/log/x'")).toBe(false);
  });

  it('still detects a real file read after a quoted argument', () => {
    expect(isBashFileRead('git commit -m "msg | head" && cat secrets.txt')).toBe(true);
  });

  it('does not scan heredoc bodies — they are data, not commands', () => {
    const commitMsg = [
      "git commit -F - <<'EOF'",
      'fix: explain the rule',
      '',
      'cat package.json and head -5 README.md are still blocked.',
      'EOF',
    ].join('\n');
    expect(isBashFileRead(commitMsg)).toBe(false);
  });

  it('ignores heredoc bodies with unquoted and indented delimiters', () => {
    expect(isBashFileRead('gh issue create --body-file - <<EOF\ncat secrets.txt\nEOF')).toBe(false);
    expect(isBashFileRead('cmd <<-END\n\tcat secrets.txt\n\tEND')).toBe(false);
  });

  it('still scans commands outside the heredoc', () => {
    expect(isBashFileRead("cat secrets.txt && git commit -F - <<'EOF'\nmsg\nEOF")).toBe(true);
  });

  it('still scans a heredoc fed to a shell interpreter', () => {
    expect(isBashFileRead('bash <<EOF\ncat secrets.txt\nEOF')).toBe(true);
    expect(isBashFileRead('sh <<EOF\nhead -5 secrets.txt\nEOF')).toBe(true);
  });

  it('resolves path-qualified commands', () => {
    expect(isBashFileRead('/bin/cat secrets.txt')).toBe(true);
    expect(isBashFileRead('/usr/bin/head -5 secrets.txt')).toBe(true);
    expect(isBashFileRead('ls | /usr/bin/head -5')).toBe(false);
  });

  it('sees through wrapper prefixes and env assignments', () => {
    expect(isBashFileRead('command cat secrets.txt')).toBe(true);
    expect(isBashFileRead('exec cat secrets.txt')).toBe(true);
    expect(isBashFileRead('env FOO=1 cat secrets.txt')).toBe(true);
    expect(isBashFileRead('FOO=1 BAR=2 /bin/cat secrets.txt')).toBe(true);
    expect(isBashFileRead('env FOO=1 ls | head -5')).toBe(false);
  });

  it('handles empty and whitespace commands', () => {
    expect(isBashFileRead('')).toBe(false);
    expect(isBashFileRead('   ')).toBe(false);
    expect(isBashFileRead('ls |')).toBe(false);
  });
});
