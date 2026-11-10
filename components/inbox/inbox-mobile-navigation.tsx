"use client";
export type InboxPane='list'|'chat'|'details';
export function inboxPaneClass(pane:InboxPane,selected:InboxPane,desktopVisible=true){
 return `${pane===selected?'flex':'hidden'} ${desktopVisible?'lg:flex':'lg:hidden'}`;
}
export function InboxMobileNavigation({view,hasPatient,onChange}:{view:InboxPane;hasPatient:boolean;onChange:(view:InboxPane)=>void}){
 return <nav aria-label="Painéis do Inbox" className="flex shrink-0 gap-2 lg:hidden">
  {([['list','Conversas'],['chat','Conversa'],['details','Detalhes']] as const).map(([pane,label])=><button key={pane} type="button" aria-pressed={view===pane} disabled={pane==='details'&&!hasPatient} onClick={()=>onChange(pane)} className={`min-w-0 flex-1 rounded border px-2 py-2 text-sm disabled:opacity-40 ${view===pane?'border-primary bg-primary/10':''}`}>{label}</button>)}
 </nav>;
}
