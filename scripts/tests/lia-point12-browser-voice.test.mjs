import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { LiaBrowserVoiceAdapter } from '../../frontend/src/integrations/liaBrowserVoice.ts';
import { deriveLiaCoreModel } from '../../frontend/src/components/lia-core-r3/liaCoreState.ts';

class MockRecognition {
  static instances = [];
  lang = '';
  continuous = true;
  interimResults = false;
  onstart = null;
  onresult = null;
  onend = null;
  onerror = null;
  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;

  constructor() { MockRecognition.instances.push(this); }
  start() { this.startCalls += 1; }
  stop() { this.stopCalls += 1; }
  abort() { this.abortCalls += 1; }
  emitStart() { this.onstart?.(); }
  emitResult(transcript, isFinal) {
    this.onresult?.({ resultIndex: 0, results: Object.assign([{ 0: { transcript }, length: 1, isFinal }], { length: 1 }) });
  }
  emitEnd() { this.onend?.(); }
  emitError(error) { this.onerror?.({ error }); }
}

class MockUtterance {
  constructor(text) { this.text = text; }
  lang = '';
  voice = null;
  onstart = null;
  onend = null;
  onerror = null;
}

function recognitionEnvironment(extra = {}) {
  MockRecognition.instances = [];
  return { SpeechRecognition: MockRecognition, ...extra };
}

function idleEvidence(extra = {}) {
  return { office: null, hud: null, hermesAvailability: 'available', chatPending: false, ...extra };
}

test('unsupported recognition preserves the text fallback', () => {
  const adapter = new LiaBrowserVoiceAdapter({});
  assert.equal(adapter.getSnapshot().state, 'unsupported');
  assert.equal(adapter.getSnapshot().recognitionSupported, false);
  assert.equal(adapter.start(), false);
  assert.match(adapter.getSnapshot().error, /no está disponible/i);
});

test('start is gesture-driven and does not claim listening before real onstart', () => {
  const adapter = new LiaBrowserVoiceAdapter(recognitionEnvironment());
  assert.equal(adapter.start(), true);
  assert.equal(adapter.getSnapshot().state, 'starting');
  const recognition = MockRecognition.instances[0];
  assert.equal(recognition.startCalls, 1);
  assert.equal(recognition.lang, 'es-MX');
  assert.equal(recognition.continuous, false);
  assert.equal(recognition.interimResults, true);
  assert.equal(adapter.start(), false, 'double start is rejected');
  recognition.emitStart();
  assert.equal(adapter.getSnapshot().state, 'listening');
});

test('real results fill a bounded transcript and onend clears listening without auto-submit', () => {
  const adapter = new LiaBrowserVoiceAdapter(recognitionEnvironment());
  const transcripts = [];
  adapter.setTranscriptListener((value) => transcripts.push(value));
  adapter.start();
  const recognition = MockRecognition.instances[0];
  recognition.emitStart();
  recognition.emitResult('borrador', false);
  assert.equal(adapter.getSnapshot().interimTranscript, 'borrador');
  recognition.emitResult(`  ${'x'.repeat(8_100)}  `, true);
  assert.equal(transcripts.length, 1);
  assert.equal(transcripts[0].length, 8_000);
  assert.equal(adapter.getSnapshot().state, 'transcript_ready');
  recognition.emitEnd();
  assert.equal(adapter.getSnapshot().state, 'transcript_ready');
  assert.equal(transcripts.length, 1, 'adapter only returns text; it never submits chat');
});

test('permission error and explicit cancel clear listening', () => {
  const adapter = new LiaBrowserVoiceAdapter(recognitionEnvironment());
  adapter.start();
  MockRecognition.instances[0].emitStart();
  MockRecognition.instances[0].emitError('not-allowed');
  assert.equal(adapter.getSnapshot().state, 'error');
  assert.match(adapter.getSnapshot().error, /denegado/i);

  adapter.start();
  const second = MockRecognition.instances[1];
  second.emitStart();
  adapter.cancel();
  assert.equal(second.abortCalls, 1);
  assert.equal(adapter.getSnapshot().state, 'idle');
});

test('synthesis speaks only after real speech onstart and clears on end/cancel', () => {
  const spoken = [];
  let cancelCalls = 0;
  const synthesis = {
    speak: (utterance) => spoken.push(utterance),
    cancel: () => { cancelCalls += 1; },
    getVoices: () => [{ lang: 'en-US' }, { lang: 'es-MX' }],
  };
  const adapter = new LiaBrowserVoiceAdapter(recognitionEnvironment({ speechSynthesis: synthesis, SpeechSynthesisUtterance: MockUtterance }));
  assert.equal(adapter.speak('Respuesta final real'), true);
  assert.equal(adapter.getSnapshot().state, 'idle');
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].lang, 'es-MX');
  assert.equal(spoken[0].voice.lang, 'es-MX');
  spoken[0].onstart();
  assert.equal(adapter.getSnapshot().state, 'speaking');
  spoken[0].onend();
  assert.equal(adapter.getSnapshot().state, 'idle');

  adapter.speak('Otra respuesta');
  spoken[1].onstart();
  adapter.cancelSpeech();
  assert.equal(adapter.getSnapshot().state, 'idle');
  assert.ok(cancelCalls >= 2);
});

test('cleanup aborts recognition and cancels synthesis', () => {
  let cancelled = false;
  const adapter = new LiaBrowserVoiceAdapter(recognitionEnvironment({
    speechSynthesis: { speak() {}, cancel() { cancelled = true; }, getVoices() { return []; } },
    SpeechSynthesisUtterance: MockUtterance,
  }));
  adapter.start();
  const recognition = MockRecognition.instances[0];
  adapter.cleanup();
  assert.equal(recognition.abortCalls, 1);
  assert.equal(cancelled, true);
});

test('listening and speaking reach Core only from explicit browser event booleans', () => {
  assert.equal(deriveLiaCoreModel(idleEvidence()).state, 'idle');
  assert.equal(deriveLiaCoreModel(idleEvidence({ voiceListening: true })).state, 'listening');
  assert.equal(deriveLiaCoreModel(idleEvidence({ voiceSpeaking: true })).state, 'speaking');
  assert.equal(deriveLiaCoreModel(idleEvidence({ chatPending: true, voiceSpeaking: true })).state, 'speaking');
  assert.equal(deriveLiaCoreModel(idleEvidence({ hermesAvailability: 'unavailable', voiceListening: true })).state, 'offline');
});

test('Point 12 integration keeps one chat path, no auto-send, no audio upload and safe browser-only APIs', async () => {
  const [app, adapter, panel, coreProvider, styles, chatClient, backendHealth, statusContract] = await Promise.all([
    readFile(new URL('../../frontend/src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/integrations/liaBrowserVoice.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/components/lia-r3/LiaConversationPanelR3.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/components/lia-core-r3/useLiaCoreState.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/styles/liaConversationR3.css', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/integrations/liaHermesChatClient.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../backend/lia-agent/src/contracts/health.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/integrations/liaSameOriginStatusAdapterContract.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(app, /requestLiaHermesResponse\(clean\)/);
  assert.match(app, /if \(originatedByVoice\) voiceAdapter\.speak\(result\.response\)/);
  assert.doesNotMatch(app, /2400|mobileOrbListening|setLÍAState\('Escuchando/);
  assert.doesNotMatch(adapter, /setTimeout|setInterval|MediaRecorder|getUserMedia|fetch\(|FormData/);
  assert.doesNotMatch(`${app}\n${adapter}`, /MediaRecorder|getUserMedia|audio\//);
  assert.match(panel, /type="submit"/);
  assert.doesNotMatch(adapter, /submit|requestLiaHermesResponse|\/api\//);
  const transcriptHandler = app.match(/setTranscriptListener\(\(transcript\)[\s\S]*?\n    \}\);/)?.[0] ?? '';
  assert.match(transcriptHandler, /setMessage\(transcript\)/);
  assert.doesNotMatch(transcriptHandler, /sendLÍA|requestLiaHermesResponse|submit/);
  assert.match(chatClient, /LIA_HERMES_CHAT_PATH = '\/api\/lia-agent\/query'/);
  assert.match(coreProvider, /voiceListening[\s\S]*voiceSpeaking/);
  assert.match(styles, /44px/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(backendHealth, /voiceEnabled: false/);
  assert.match(statusContract, /voiceEnabled: false/);
  assert.match(statusContract, /voiceProtected: true/);
});
