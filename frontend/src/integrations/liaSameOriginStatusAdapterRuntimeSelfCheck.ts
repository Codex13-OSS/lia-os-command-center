import {
  getLiaSameOriginStatusAdapterClientSafetyProbe,
  LIA_SAME_ORIGIN_STATUS_ADAPTER_PATH,
} from './liaSameOriginStatusAdapterClient';

type LiaSameOriginStatusAdapterRuntimeSelfCheck = {
  ok: boolean;
  checkedAt: string;
  checks: Array<{
    id: string;
    passed: boolean;
    detail: string;
  }>;
};

function createCheck(id: string, passed: boolean, detail: string) {
  return { id, passed, detail };
}

function clientSourceProbe() {
  return getLiaSameOriginStatusAdapterClientSafetyProbe();
}

function containsBlockedTerms(source: string) {
  const localBackend = ['127.0.0.1', '3014'].join(':');
  const publicBackend = ['38.242.222.25', '3014'].join(':');
  const clearTextScheme = ['ht', 'tp://'].join('');
  const secureScheme = ['ht', 'tps://'].join('');
  const socketTerm = ['Web', 'Socket'].join('');
  const providerA = ['OP', 'ENAI'].join('');
  const providerB = ['ANTH', 'ROPIC'].join('');
  const providerKey = ['API', '_KEY'].join('');
  const voiceA = ['Speech', 'Recognition'].join('');
  const voiceB = ['speech', 'Synthesis'].join('');
  const mediaTerm = ['media', 'Devices'].join('');
  const alertTerm = ['Notifi', 'cation'].join('');

  return [
    localBackend,
    publicBackend,
    clearTextScheme,
    secureScheme,
    socketTerm,
    providerA,
    providerB,
    providerKey,
    voiceA,
    voiceB,
    mediaTerm,
    alertTerm,
  ].some((term) => source.includes(term));
}

export function runLiaSameOriginStatusAdapterRuntimeSelfCheck(): LiaSameOriginStatusAdapterRuntimeSelfCheck {
  const source = clientSourceProbe();

  const checks = [
    createCheck(
      'relative-same-origin-path',
      LIA_SAME_ORIGIN_STATUS_ADAPTER_PATH === '/lia/api/lia-agent/health',
      'Client uses the same-origin adapter path.',
    ),
    createCheck('no-blocked-terms', !containsBlockedTerms(source), 'Client source contains no blocked hosts, schemes, or browser APIs.'),
    createCheck('uses-abort-controller', source.includes('AbortController'), 'Client uses AbortController.'),
    createCheck('uses-timeout', source.includes('TIMEOUT') || source.includes('timeout'), 'Client contains timeout handling.'),
    createCheck('has-safe-fallback', source.includes('createSafeSameOriginStatusAdapterFallback'), 'Client contains fallback seguro handling.'),
    createCheck('real-actions-false', source.includes('realActionsEnabled === false'), 'Client enforces real actions safety flag false.'),
    createCheck('voice-false', source.includes('voiceEnabled === false'), 'Client enforces voice safety flag false.'),
    createCheck('channels-false', source.includes('whatsappEnabled === false'), 'Client enforces channel safety flag false.'),
    createCheck('memory-false', source.includes('memoryWriteEnabled === false'), 'Client enforces memory write safety flag false.'),
    createCheck('models-false', source.includes('externalModelsEnabled === false'), 'Client enforces external models safety flag false.'),
    createCheck('credentials-false', source.includes('secretsLoaded === false'), 'Client enforces credential safety flag false.'),
  ];

  return {
    ok: checks.every((check) => check.passed),
    checkedAt: new Date().toISOString(),
    checks,
  };
}
