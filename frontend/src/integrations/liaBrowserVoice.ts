export type LiaBrowserVoiceState =
  | 'unsupported'
  | 'idle'
  | 'starting'
  | 'listening'
  | 'transcript_ready'
  | 'error'
  | 'speaking';

export const LIA_BROWSER_VOICE_LANG = 'es-MX';
export const LIA_BROWSER_VOICE_MAX_TRANSCRIPT_CHARACTERS = 8_000;

type RecognitionResultLike = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
};

type RecognitionEventLike = {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: RecognitionResultLike;
  };
};

type RecognitionErrorEventLike = { readonly error?: string };

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: RecognitionErrorEventLike) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechSynthesisVoiceLike = { readonly lang: string; readonly voiceURI?: string };

type SpeechSynthesisUtteranceLike = {
  lang: string;
  voice: SpeechSynthesisVoiceLike | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

type SpeechSynthesisUtteranceConstructor = new (text: string) => SpeechSynthesisUtteranceLike;

type SpeechSynthesisLike = {
  speak: (utterance: SpeechSynthesisUtteranceLike) => void;
  cancel: () => void;
  getVoices: () => SpeechSynthesisVoiceLike[];
};

export type LiaBrowserVoiceEnvironment = {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
  speechSynthesis?: SpeechSynthesisLike;
  SpeechSynthesisUtterance?: SpeechSynthesisUtteranceConstructor;
};

export type LiaBrowserVoiceSnapshot = {
  state: LiaBrowserVoiceState;
  recognitionSupported: boolean;
  synthesisSupported: boolean;
  interimTranscript: string;
  error: string | null;
};

type Listener = () => void;
type TranscriptListener = (transcript: string) => void;

function browserEnvironment(): LiaBrowserVoiceEnvironment {
  if (typeof window === 'undefined') return {};
  const browserWindow = window as unknown as LiaBrowserVoiceEnvironment;
  return {
    SpeechRecognition: browserWindow.SpeechRecognition,
    webkitSpeechRecognition: browserWindow.webkitSpeechRecognition,
    speechSynthesis: browserWindow.speechSynthesis,
    SpeechSynthesisUtterance: browserWindow.SpeechSynthesisUtterance,
  };
}

function recognitionErrorCopy(error?: string): string {
  if (error === 'not-allowed' || error === 'service-not-allowed') return 'Permiso de micrófono denegado.';
  if (error === 'audio-capture') return 'No hay un micrófono disponible.';
  if (error === 'no-speech') return 'No se detectó voz. Intenta nuevamente.';
  return 'No fue posible iniciar el reconocimiento de voz.';
}

export class LiaBrowserVoiceAdapter {
  private readonly environment: LiaBrowserVoiceEnvironment;
  private readonly recognitionConstructor?: SpeechRecognitionConstructor;
  private recognition: SpeechRecognitionLike | null = null;
  private utterance: SpeechSynthesisUtteranceLike | null = null;
  private listeners = new Set<Listener>();
  private transcriptListener: TranscriptListener | null = null;
  private sessionHasFinalTranscript = false;
  private language = LIA_BROWSER_VOICE_LANG;
  private preferredVoiceURI: string | null = null;
  private snapshot: LiaBrowserVoiceSnapshot;

  constructor(environment: LiaBrowserVoiceEnvironment = browserEnvironment()) {
    this.environment = environment;
    this.recognitionConstructor = environment.SpeechRecognition ?? environment.webkitSpeechRecognition;
    this.snapshot = {
      state: this.recognitionConstructor ? 'idle' : 'unsupported',
      recognitionSupported: Boolean(this.recognitionConstructor),
      synthesisSupported: Boolean(environment.speechSynthesis && environment.SpeechSynthesisUtterance),
      interimTranscript: '',
      error: null,
    };
  }

  getSnapshot = (): LiaBrowserVoiceSnapshot => this.snapshot;

  configure(preferences: { language?: string; voiceURI?: string | null }): void {
    if (preferences.language?.trim()) this.language = preferences.language.trim();
    this.preferredVoiceURI = preferences.voiceURI ?? null;
  }


  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setTranscriptListener(listener: TranscriptListener | null): void {
    this.transcriptListener = listener;
  }

  start(): boolean {
    if (!this.recognitionConstructor) {
      this.update({ state: 'unsupported', error: 'El reconocimiento de voz no está disponible en este navegador.' });
      return false;
    }
    if (this.recognition || this.snapshot.state === 'starting' || this.snapshot.state === 'listening') return false;

    this.cancelSpeech();
    const recognition = new this.recognitionConstructor();
    this.recognition = recognition;
    this.sessionHasFinalTranscript = false;
    recognition.lang = this.language;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onstart = () => {
      if (this.recognition === recognition) this.update({ state: 'listening', error: null });
    };
    recognition.onresult = (event) => {
      if (this.recognition !== recognition) return;
      let interim = '';
      let finalTranscript = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result?.[0]?.transcript ?? '';
        if (result?.isFinal) finalTranscript += text;
        else interim += text;
      }
      const boundedInterim = interim.trim().slice(0, LIA_BROWSER_VOICE_MAX_TRANSCRIPT_CHARACTERS);
      if (finalTranscript.trim()) {
        const boundedFinal = finalTranscript.trim().slice(0, LIA_BROWSER_VOICE_MAX_TRANSCRIPT_CHARACTERS);
        this.sessionHasFinalTranscript = true;
        this.update({ state: 'transcript_ready', interimTranscript: '', error: null });
        this.transcriptListener?.(boundedFinal);
      } else {
        this.update({ interimTranscript: boundedInterim });
      }
    };
    recognition.onerror = (event) => {
      if (this.recognition !== recognition) return;
      this.recognition = null;
      this.clearRecognitionHandlers(recognition);
      this.update({ state: 'error', interimTranscript: '', error: recognitionErrorCopy(event.error) });
    };
    recognition.onend = () => {
      if (this.recognition !== recognition) return;
      this.recognition = null;
      this.clearRecognitionHandlers(recognition);
      this.update({
        state: this.sessionHasFinalTranscript ? 'transcript_ready' : 'idle',
        interimTranscript: '',
        error: null,
      });
    };

    this.update({ state: 'starting', interimTranscript: '', error: null });
    try {
      recognition.start();
      return true;
    } catch {
      this.recognition = null;
      this.clearRecognitionHandlers(recognition);
      this.update({ state: 'error', error: 'No fue posible iniciar el reconocimiento de voz.' });
      return false;
    }
  }

  stop(): void {
    this.recognition?.stop();
  }

  cancel(): void {
    const recognition = this.recognition;
    this.recognition = null;
    if (recognition) {
      this.clearRecognitionHandlers(recognition);
      recognition.abort();
    }
    this.update({
      state: this.recognitionConstructor ? 'idle' : 'unsupported',
      interimTranscript: '',
      error: null,
    });
  }

  speak(text: string): boolean {
    const synthesis = this.environment.speechSynthesis;
    const Utterance = this.environment.SpeechSynthesisUtterance;
    const clean = text.trim();
    if (!synthesis || !Utterance || !clean) return false;

    this.cancelSpeech();
    const utterance = new Utterance(clean);
    utterance.lang = this.language;
    utterance.voice = synthesis.getVoices().find((voice) => this.preferredVoiceURI !== null && voice.voiceURI === this.preferredVoiceURI)
      ?? synthesis.getVoices().find((voice) => voice.lang.toLowerCase() === this.language.toLowerCase())
      ?? synthesis.getVoices().find((voice) => voice.lang.toLowerCase().startsWith(this.language.split('-')[0].toLowerCase()))
      ?? null;
    utterance.onstart = () => {
      if (this.utterance === utterance) this.update({ state: 'speaking', error: null });
    };
    const finish = () => {
      if (this.utterance !== utterance) return;
      this.utterance = null;
      this.clearUtteranceHandlers(utterance);
      this.update({ state: this.recognitionConstructor ? 'idle' : 'unsupported' });
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    this.utterance = utterance;
    synthesis.speak(utterance);
    return true;
  }

  cancelSpeech(): void {
    const utterance = this.utterance;
    this.utterance = null;
    if (utterance) this.clearUtteranceHandlers(utterance);
    this.environment.speechSynthesis?.cancel();
    if (this.snapshot.state === 'speaking') {
      this.update({ state: this.recognitionConstructor ? 'idle' : 'unsupported' });
    }
  }

  cleanup(): void {
    this.cancel();
    this.cancelSpeech();
    this.transcriptListener = null;
    this.listeners.clear();
  }

  private update(update: Partial<LiaBrowserVoiceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    this.listeners.forEach((listener) => listener());
  }

  private clearRecognitionHandlers(recognition: SpeechRecognitionLike): void {
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onend = null;
    recognition.onerror = null;
  }

  private clearUtteranceHandlers(utterance: SpeechSynthesisUtteranceLike): void {
    utterance.onstart = null;
    utterance.onend = null;
    utterance.onerror = null;
  }
}
