// The dock's stylesheet. Plain CSS with a `pa-agent-` prefix and CSS variables, so a host can
// theme it (`--pa-accent`, `--pa-bg`, ...) without Tailwind or a component library. React 19
// hoists and de-duplicates it (`<style href precedence>`), so two docks inject it once.

export const DOCK_CSS = `
.pa-agent-root{--pa-accent:#4f46e5;--pa-accent-fg:#fff;--pa-bg:#fff;--pa-fg:#111827;--pa-muted:#6b7280;--pa-border:#e5e7eb;--pa-soft:#f3f4f6;--pa-user:#eef2ff;--pa-warn:#b45309;--pa-warn-bg:#fffbeb;--pa-radius:14px;--pa-font:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-family:var(--pa-font);color:var(--pa-fg);font-size:14px;line-height:1.45}
.pa-agent-root[data-theme="dark"]{--pa-bg:#111318;--pa-fg:#e5e7eb;--pa-muted:#9ca3af;--pa-border:#2a2e37;--pa-soft:#1b1e25;--pa-user:#1e2140;--pa-warn:#fbbf24;--pa-warn-bg:#2a2210}
@media (prefers-color-scheme:dark){.pa-agent-root[data-theme="auto"]{--pa-bg:#111318;--pa-fg:#e5e7eb;--pa-muted:#9ca3af;--pa-border:#2a2e37;--pa-soft:#1b1e25;--pa-user:#1e2140;--pa-warn:#fbbf24;--pa-warn-bg:#2a2210}}
.pa-agent-root *{box-sizing:border-box}
.pa-agent-launcher{position:fixed;z-index:110;bottom:20px;right:20px;border:0;border-radius:999px;padding:12px 18px;background:var(--pa-accent);color:var(--pa-accent-fg);font:600 14px var(--pa-font);box-shadow:0 8px 24px rgba(0,0,0,.18);cursor:pointer}
.pa-agent-root[data-position="bottom-left"] .pa-agent-launcher{right:auto;left:20px}
.pa-agent-panel{position:fixed;z-index:111;bottom:20px;right:20px;width:min(400px,calc(100vw - 24px));height:min(640px,calc(100vh - 40px));display:flex;flex-direction:column;background:var(--pa-bg);border:1px solid var(--pa-border);border-radius:var(--pa-radius);box-shadow:0 18px 50px rgba(0,0,0,.22);overflow:hidden}
.pa-agent-root[data-position="bottom-left"] .pa-agent-panel{right:auto;left:20px}
.pa-agent-panel[data-expanded="true"]{width:min(760px,calc(100vw - 24px));height:calc(100vh - 40px)}
@media (max-width:520px){.pa-agent-panel{inset:auto 0 0 0;width:100vw;height:min(92dvh,100vh);border-radius:var(--pa-radius) var(--pa-radius) 0 0}}
.pa-agent-header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--pa-border)}
.pa-agent-title{flex:1;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pa-agent-icon-btn{border:0;background:transparent;color:inherit;width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:15px;display:inline-flex;align-items:center;justify-content:center}
.pa-agent-icon-btn:hover:not(:disabled){background:var(--pa-soft)}
.pa-agent-icon-btn:disabled{opacity:.45;cursor:default}
.pa-agent-icon-btn[aria-pressed="true"]{background:var(--pa-soft);color:var(--pa-accent)}
.pa-agent-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px}
.pa-agent-msg{display:flex}
.pa-agent-msg-user{justify-content:flex-end}
.pa-agent-bubble{max-width:88%;padding:8px 12px;border-radius:12px;background:var(--pa-soft);overflow-wrap:anywhere}
.pa-agent-msg-user .pa-agent-bubble{background:var(--pa-user)}
.pa-agent-msg-narration .pa-agent-bubble{background:transparent;border:1px dashed var(--pa-border);font-style:italic}
.pa-agent-msg-error .pa-agent-bubble{background:var(--pa-warn-bg);color:var(--pa-warn)}
.pa-agent-user-text{margin:0;white-space:pre-wrap}
.pa-agent-md p{margin:0 0 6px}.pa-agent-md p:last-child{margin-bottom:0}
.pa-agent-md ul,.pa-agent-md ol{margin:4px 0 6px;padding-left:20px}
.pa-agent-md hr{border:0;border-top:1px solid var(--pa-border);margin:10px 0}
.pa-agent-md code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;background:rgba(127,127,127,.14);padding:1px 4px;border-radius:4px}
.pa-agent-md pre{overflow-x:auto;background:rgba(127,127,127,.12);padding:8px;border-radius:8px}
.pa-agent-md a{color:var(--pa-accent)}
.pa-agent-note{margin:6px 0 0;font-size:12px;color:var(--pa-muted)}
.pa-agent-retry{margin-top:8px}
.pa-agent-btn{border:1px solid var(--pa-border);background:var(--pa-bg);color:inherit;border-radius:8px;padding:6px 12px;font:500 13px var(--pa-font);cursor:pointer}
.pa-agent-btn:disabled{opacity:.5;cursor:default}
.pa-agent-btn-primary{background:var(--pa-accent);border-color:var(--pa-accent);color:var(--pa-accent-fg);flex:1}
.pa-agent-danger{color:#dc2626}
.pa-agent-thinking{display:flex;align-items:center;gap:8px;color:var(--pa-muted);font-size:13px;padding:2px 4px}
.pa-agent-dots{display:inline-flex;gap:3px}
.pa-agent-dots span{width:6px;height:6px;border-radius:50%;background:currentColor;animation:pa-agent-blink 1.2s infinite ease-in-out}
.pa-agent-dots span:nth-child(2){animation-delay:.15s}.pa-agent-dots span:nth-child(3){animation-delay:.3s}
@keyframes pa-agent-blink{0%,80%,100%{opacity:.25}40%{opacity:1}}
@media (prefers-reduced-motion:reduce){.pa-agent-dots span{animation:none}}
.pa-agent-footer{border-top:1px solid var(--pa-border);padding:8px 10px 10px;display:flex;flex-direction:column;gap:8px}
.pa-agent-chips{display:flex;flex-wrap:wrap;gap:6px}
.pa-agent-chip{border:1px solid var(--pa-border);background:var(--pa-bg);color:inherit;border-radius:999px;padding:5px 11px;font:500 12.5px var(--pa-font);cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.pa-agent-chip:hover:not(:disabled){border-color:var(--pa-accent)}
.pa-agent-chip-tag{font-size:10.5px;color:var(--pa-warn)}
.pa-agent-composer{display:flex;align-items:flex-end;gap:4px;border:1px solid var(--pa-border);border-radius:12px;padding:4px 4px 4px 10px;background:var(--pa-bg)}
.pa-agent-composer:focus-within{border-color:var(--pa-accent)}
.pa-agent-input{flex:1;border:0;outline:0;resize:none;background:transparent;color:inherit;font:14px/1.4 var(--pa-font);max-height:140px;padding:6px 0;field-sizing:content}
.pa-agent-send:not(:disabled){background:var(--pa-accent);color:var(--pa-accent-fg)}
.pa-agent-recording{color:#dc2626!important}
.pa-agent-card{border:1px solid rgba(217,119,6,.45);background:var(--pa-warn-bg);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.pa-agent-card-title{margin:0;font-weight:600}
.pa-agent-card-details{margin:0;padding-left:18px;max-height:min(11rem,30vh);overflow-y:auto;color:var(--pa-muted);font-size:12.5px;overflow-wrap:anywhere}
.pa-agent-card-expired{margin:0;font-size:12px;color:var(--pa-warn);font-weight:500}
.pa-agent-card-buttons{display:flex;gap:8px}
.pa-agent-card-hint{margin:0;font-size:11px;color:var(--pa-muted)}
.pa-agent-history{position:absolute;inset:52px 0 0 0;background:var(--pa-bg);z-index:2;display:flex;flex-direction:column;padding:10px 12px;gap:8px;overflow:hidden}
.pa-agent-history-head{display:flex;align-items:center;justify-content:space-between}
.pa-agent-history-list{list-style:none;margin:0;padding:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
.pa-agent-history-list li{display:flex;align-items:center;gap:4px;border-radius:8px}
.pa-agent-history-list li.pa-agent-current{background:var(--pa-soft)}
.pa-agent-history-open{flex:1;min-width:0;display:flex;justify-content:space-between;gap:8px;border:0;background:transparent;color:inherit;text-align:left;padding:8px;cursor:pointer;font:inherit}
.pa-agent-history-open span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pa-agent-history-open small{color:var(--pa-muted);flex:none}
.pa-agent-empty{color:var(--pa-muted);padding:8px 4px}
.pa-agent-empty p{margin:0 0 10px}
.pa-agent-overlay{pointer-events:none;position:fixed;inset:0;z-index:120}
.pa-agent-ring{position:absolute;border-radius:10px;box-shadow:0 0 0 3px var(--pa-accent,#4f46e5),0 0 0 9999px rgba(0,0,0,.35);transition:all .3s ease-out}
.pa-agent-caption{position:absolute;max-width:20rem;border-radius:8px;background:var(--pa-accent,#4f46e5);color:#fff;padding:6px 10px;font:500 12.5px system-ui,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.25);transition:all .3s}
@media (prefers-reduced-motion:reduce){.pa-agent-ring,.pa-agent-caption{transition:none}}
.pa-agent-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;
