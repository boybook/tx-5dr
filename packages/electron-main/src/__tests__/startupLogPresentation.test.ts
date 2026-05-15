import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type Classifier = (value: string) => string;

function loadStartupHtml(): string {
  const htmlPath = path.resolve(__dirname, '../../assets/loading.html');
  return readFileSync(htmlPath, 'utf8');
}

function loadStartupLogClassifier(): Classifier {
  const html = loadStartupHtml();
  const match = html.match(/\/\/ STARTUP_LOG_CLASSIFIER_START([\s\S]*?)\/\/ STARTUP_LOG_CLASSIFIER_END/);

  if (!match) {
    throw new Error('startup log classifier markers not found');
  }

  return new Function(`${match[1]}\nreturn getLogLineClassName;`)() as Classifier;
}

const getLogLineClassName = loadStartupLogClassifier();

describe('startup loading log presentation', () => {
  it('starts with a collapsed one-line log preview', () => {
    const html = loadStartupHtml();

    expect(html).toContain('class="log-preview" id="log-preview"');
    expect(html).toContain('.log-preview:hover');
    expect(html).toContain('.log-wrap {\n    position: relative;\n    display: none;');
    expect(html).toContain('.shell.logs-expanded .log-wrap {\n    display: block;');
    expect(html).toContain('let isExpanded = false;');
    expect(html).toContain("shell.classList.toggle('logs-expanded', isExpanded);");
  });

  it('expands the full log card after click or startup error', () => {
    const html = loadStartupHtml();

    expect(html).toContain("logPreview.addEventListener('click', () => {");
    expect(html).toContain('startupMark.classList.add(\'has-error\');\n      isExpanded = true;');
  });

  it('keeps normal child lifecycle lines neutral', () => {
    const neutralLines = [
      '[2026-05-10 12:37:12.342] [info] [ElectronMain] [child:client-tools] starting entry=/Users/fangyizhou/Documents/coding/tx-5dr/packages/client-tools/src/proxy.js cwd=/Users/fangyizhou/Documents/coding/tx-5dr/packages/client-tools/src',
      '[2026-05-10 12:37:12.345] [info] [ElectronMain] [child:client-tools] started pid=28337',
      '[2026-05-10 12:37:12.346] [info] [ElectronMain] [child:server] stopping pid=28336',
      '[2026-05-10 12:37:12.347] [info] [ElectronMain] [child:server] stopped pid=28336',
      '[2026-05-10 12:37:12.348] [info] [ElectronMain] [child:server] exited pid=1 code=0 signal=null',
    ];

    for (const line of neutralLines) {
      expect(getLogLineClassName(line)).toBe('log-line');
    }
  });

  it('highlights explicit startup problems', () => {
    const problemLines = [
      '[2026-05-10 12:37:12.342] [error] [ElectronMain] [child:server] failed to start: spawn ENOENT',
      '[2026-05-10 12:37:12.342] [error] [ElectronMain] [child:server] node binary not found: /missing/node',
      '[2026-05-10 12:37:12.342] [info] [ElectronMain] [child:server] entry not found: /missing/server.js',
      '[2026-05-10 12:37:12.342] [info] [ElectronMain] [child:server] stop timeout, force kill',
    ];

    for (const line of problemLines) {
      expect(getLogLineClassName(line)).toBe('log-line startup-problem');
    }
  });

  it('highlights abnormal child exits only', () => {
    expect(getLogLineClassName('[2026-05-10 12:37:12.348] [info] [ElectronMain] [child:server] exited pid=1 code=1 signal=null'))
      .toBe('log-line startup-problem');
    expect(getLogLineClassName('[2026-05-10 12:37:12.348] [info] [ElectronMain] [child:server] exited pid=1 code=null signal=SIGKILL'))
      .toBe('log-line startup-problem');
    expect(getLogLineClassName('[2026-05-10 12:37:12.348] [info] [ElectronMain] [child:server] exited pid=1 code=0 signal=null'))
      .toBe('log-line');
  });

  it('highlights bracketed error levels outside child logs', () => {
    expect(getLogLineClassName('[2026-05-10 12:37:12.348] [error] [ElectronMain] startup error state updated'))
      .toBe('log-line startup-problem');
    expect(getLogLineClassName('[2026-05-10T04:37:12.389Z] [INFO ] [console] [HamlibConnection] Hamlib radio connected successfully'))
      .toBe('log-line');
  });
});
