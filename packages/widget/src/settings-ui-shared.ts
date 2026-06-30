// Shared CSS for settings panels (voice + assistant).

export const CSS = `
* { box-sizing: border-box; font-family: -apple-system, system-ui, Segoe UI, Roboto, sans-serif; }
.wrap { color: #e7f5ec; font-size: 14px; line-height: 1.45; }
.hint { margin: 0 0 14px; font-size: 13px; color: #9ab4a6; }
.row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.label { width: 140px; flex-shrink: 0; color: #9ab4a6; font-size: 13px; }
.field { flex: 1; min-width: 180px; }
select, label.field { display: block; width: 100%; max-width: 320px; }
select {
  background: #0b1310; border: 1px solid #244234; color: #e7f5ec;
  border-radius: 8px; padding: 8px 10px; font-size: 14px;
}
.check { display: flex; align-items: center; gap: 8px; cursor: pointer; max-width: 320px; }
.modal-backdrop {
  position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,.55);
  display: flex; align-items: center; justify-content: center; padding: 16px;
}
.modal {
  width: min(520px, 100%); max-height: 90vh; overflow: auto;
  background: #0f1715; border: 1px solid #1f3a2c; border-radius: 16px;
  padding: 18px 20px; box-shadow: 0 20px 60px rgba(0,0,0,.5);
}
.modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.modal-head h2 { margin: 0; font-size: 18px; font-weight: 600; }
.modal-foot { margin-top: 16px; display: flex; justify-content: flex-end; gap: 10px; align-items: center; }
.btn {
  border: none; border-radius: 8px; padding: 8px 14px; cursor: pointer; font-size: 14px; font-weight: 500;
}
.btn-ghost { background: transparent; color: #9ab4a6; }
.btn-ghost:hover { color: #e7f5ec; }
.btn-primary { background: #16a34a; color: #fff; }
.btn-primary:hover { background: #15803d; }
.link { color: #9ab4a6; font-size: 13px; text-decoration: none; }
.link:hover { color: #e7f5ec; }
`;
