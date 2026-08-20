import type { AgendaEventOccurrenceR3 } from '../../domain/agendaRecurrenceR3';
import type { AgendaConflictR3 } from '../../selectors/agendaSelectorsR3';
import type { AgendaStoreSnapshotR3 } from '../../store/agendaStoreR3';
import type { LiaConversationController } from '../lia-r3/liaConversationController';
import { LiaLocationWeatherR3 } from '../dashboard-r3/LiaLocationWeatherR3';
type Props={snapshot:AgendaStoreSnapshotR3;next?:AgendaEventOccurrenceR3;conflicts:AgendaConflictR3[];onCreate:()=>void;onDashboard:()=>void;onDocuments:()=>void;conversationController?:LiaConversationController};
export function AgendaExecutiveRailR3({snapshot,next,conflicts,onCreate,onDashboard,onDocuments}:Props){
 const status = snapshot.persistenceStatus === 'error' || snapshot.persistenceSource === 'corrupt' ? 'Error de datos' : snapshot.persistenceSource === 'migrated_v1' ? 'Datos migrados' : snapshot.persistenceSource === 'v3' ? 'Sincronizada' : 'Solo memoria';
 const prep=snapshot.events.filter(e=>e.preparationMinutes>0&&e.status!=='completed'&&e.status!=='cancelled').slice(0,3);
 return <aside className="lia-dash-r3-rail-shell lia-agenda-r3-rail" aria-label="Resumen ejecutivo de Agenda"><LiaLocationWeatherR3/><section><h2>Estado de Agenda</h2><strong>{status}</strong></section><section><h2>Próxima reunión</h2><p>{next?.event.title??'Sin reuniones próximas'}</p></section><section><h2>Conflictos</h2><strong>{conflicts.length}</strong></section><section><h2>Preparaciones pendientes</h2>{prep.length ? prep.map(e=><p key={e.id}>{e.title} · {e.preparationMinutes} min</p>) : <p>Sin preparaciones pendientes</p>}</section><section><h2>Acciones rápidas</h2><button type="button" onClick={onCreate}>Nueva cita</button><button type="button" onClick={onDashboard}>Volver a Inicio</button><button type="button" onClick={onDocuments}>Documentos</button></section><section><h2>Actividad reciente</h2>{snapshot.events.length ? snapshot.events.slice().sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).slice(0,3).map(e=><p key={e.id}>{e.title}</p>) : <p>Sin actividad registrada</p>}</section></aside>
}
