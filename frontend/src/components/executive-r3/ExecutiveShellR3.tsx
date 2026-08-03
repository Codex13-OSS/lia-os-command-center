import { useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { DashboardHeaderR3 } from '../dashboard-r3/DashboardHeaderR3';
import { DashboardSidebarR3 } from '../dashboard-r3/DashboardSidebarR3';
import { LiaConversationPanelR3 } from '../lia-r3/LiaConversationPanelR3';
import type { LiaConversationController } from '../lia-r3/liaConversationController';

export type ExecutiveSectionR3 = 'dashboard' | 'agenda' | 'projects' | 'processes' | 'documents' | 'alerts' | 'agents' | 'settings';
type Props = { activeSection: ExecutiveSectionR3; onDashboard:()=>void; onAgenda:()=>void; onProjects:()=>void; onTracking:()=>void; onDocuments:()=>void; onAlerts:()=>void; onLogout:()=>void; mainAriaLabel:string; mainClassName?:string; rail:ReactNode; children:ReactNode; now?:Date; conversationController?:LiaConversationController };
const COMPACT=72, SNAP=206, EXPANDED=230, QUERY='(max-width: 720px)';
const subscribe=(fn:()=>void)=>{const q=window.matchMedia(QUERY);q.addEventListener('change',fn);return()=>q.removeEventListener('change',fn)};
const snapshot=()=>window.matchMedia(QUERY).matches;
export function ExecutiveShellR3(props:Props){
 const [width,setWidth]=useState(EXPANDED),[resizing,setResizing]=useState(false); const mobile=useSyncExternalStore(subscribe,snapshot,()=>false);
 const presentation=mobile?'compact':width<=88?'compact':width<180?'intermediate':'expanded'; const effective=mobile?COMPACT:width;
 const toggle=()=>{if(!mobile)setWidth(v=>v<=88?EXPANDED:COMPACT)};
 const down=(e:ReactPointerEvent<HTMLDivElement>)=>{if(e.pointerType==='touch')return;e.preventDefault();e.currentTarget.setPointerCapture?.(e.pointerId);setResizing(true)};
 const move=(e:ReactPointerEvent<HTMLDivElement>)=>{if(!resizing||!e.currentTarget.hasPointerCapture?.(e.pointerId))return;const left=e.currentTarget.closest('.lia-dash-r3-shell')?.getBoundingClientRect().left??0;setWidth(Math.min(EXPANDED,Math.max(COMPACT,e.clientX-left)))};
 const up=(e:ReactPointerEvent<HTMLDivElement>)=>{if(!resizing)return;if(e.currentTarget.hasPointerCapture?.(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);setResizing(false);setWidth(v=>v<=92?COMPACT:v>=188&&v<=220?SNAP:Math.min(EXPANDED,Math.max(COMPACT,v)))};
 return <main className={`lia-dash-r3-shell is-${presentation}${resizing?' is-resizing lia-dash-r3-shell-resizing':''}${props.mainClassName?` ${props.mainClassName}`:''}`} style={{'--lia-dash-r3-sidebar-width':`${effective}px`} as CSSProperties}>
  <div className="lia-dash-r3-ambient" aria-hidden="true"><i className="lia-dash-r3-ambient-map"/><i className="lia-dash-r3-ambient-top"/><i className="lia-dash-r3-ambient-rail"/><i className="lia-dash-r3-ambient-grain"/></div>
  <DashboardSidebarR3 {...props} activeSection={props.activeSection} presentation={presentation} isResizing={resizing} onToggle={toggle} onResizeStart={down} onResize={move} onResizeEnd={up}/>
  <DashboardHeaderR3 now={props.now??new Date()} conversationController={props.conversationController}/>
  {props.conversationController && <LiaConversationPanelR3 controller={props.conversationController}/>}<section className="lia-dash-r3-main" aria-label={props.mainAriaLabel}>{props.children}</section>{props.rail}
 </main>
}
