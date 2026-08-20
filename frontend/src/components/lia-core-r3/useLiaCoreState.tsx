import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { readLiaAutonomyHud, type LiaAutonomyHud } from '../../integrations/liaAutonomyHudClient';
import { readLiaHermesStatus } from '../../integrations/liaHermesStatusClient';
import { readLiaOffice, type LiaOfficeReadModel } from '../../integrations/liaOfficeClient';
import { LIA_GOAL_CREATED_EVENT } from '../../integrations/liaProjectGoalClient';
import { deriveLiaCoreModel, hasCompletedEvidence, type LiaCoreModel, type LiaHermesAvailability } from './liaCoreState';

const REFRESH_MS = 2_500;
const COMPLETION_CONFIRMATION_MS = 1_800;

type LiaCoreReadModel = {
  hud: LiaAutonomyHud | null;
  office: LiaOfficeReadModel | null;
  loaded: boolean;
  core: LiaCoreModel;
  refresh: () => Promise<void>;
};

const fallbackCore = deriveLiaCoreModel({ office: null, hud: null, hermesAvailability: 'unknown', chatPending: false });
const LiaCoreContext = createContext<LiaCoreReadModel>({ hud: null, office: null, loaded: false, core: fallbackCore, refresh: async () => undefined });

export function LiaCoreStateProvider({ chatPending = false, voiceListening = false, voiceSpeaking = false, children }: { chatPending?: boolean; voiceListening?: boolean; voiceSpeaking?: boolean; children: ReactNode }) {
  const [readModel, setReadModel] = useState<{ hud: LiaAutonomyHud | null; office: LiaOfficeReadModel | null; loaded: boolean; hermesAvailability: LiaHermesAvailability }>({ hud: null, office: null, loaded: false, hermesAvailability: 'unknown' });
  const [completionTransition, setCompletionTransition] = useState(false);
  const initialized = useRef(false);
  const previousCompleted = useRef(false);

  const refresh = useCallback(async () => {
    const [hud, office, hermes] = await Promise.all([readLiaAutonomyHud(), readLiaOffice(), readLiaHermesStatus()]);
    setReadModel({ hud, office, loaded: true, hermesAvailability: hermes.state === 'available' ? 'available' : 'unavailable' });
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    window.addEventListener(LIA_GOAL_CREATED_EVENT, refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(LIA_GOAL_CREATED_EVENT, refresh);
    };
  }, [refresh]);

  useEffect(() => {
    if (!readModel.loaded) return;
    const completed = hasCompletedEvidence(readModel.office, readModel.hud);
    if (initialized.current && completed && !previousCompleted.current) setCompletionTransition(true);
    initialized.current = true;
    previousCompleted.current = completed;
  }, [readModel]);

  useEffect(() => {
    if (!completionTransition) return;
    const timer = window.setTimeout(() => setCompletionTransition(false), COMPLETION_CONFIRMATION_MS);
    return () => window.clearTimeout(timer);
  }, [completionTransition]);

  const core = useMemo(() => deriveLiaCoreModel({
    office: readModel.office,
    hud: readModel.hud,
    hermesAvailability: readModel.hermesAvailability,
    chatPending,
    voiceListening,
    voiceSpeaking,
    completionTransition,
  }), [chatPending, completionTransition, readModel, voiceListening, voiceSpeaking]);

  return <LiaCoreContext.Provider value={{ hud: readModel.hud, office: readModel.office, loaded: readModel.loaded, core, refresh }}>{children}</LiaCoreContext.Provider>;
}

export function useLiaCoreState(): LiaCoreReadModel {
  return useContext(LiaCoreContext);
}
