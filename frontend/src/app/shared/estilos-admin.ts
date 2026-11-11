export const ESTILOS_ADMIN = `
  :host { display: block; color: #0f172a; --brand: #1d4ed8; --navy: #0a1a3a; --line: #e2e8f4; --muted: #5a6784; --soft: #eef2ff; }
  * { box-sizing: border-box; }
  .wrap { max-width: 1240px; margin: 0 auto; padding: 24px 20px 80px; }

  /* ---------- Encabezado de página ---------- */
  .cab { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 22px; padding: 26px 30px; color: #fff; border-radius: 20px;
    background: radial-gradient(70% 150% at 0% 0%, #1b3c8c 0%, transparent 60%), radial-gradient(60% 120% at 100% 100%, #5a1030 0%, transparent 65%), var(--navy); }
  .cab h1, .cab h2 { margin: 6px 0 4px; font-size: 1.6rem; letter-spacing: -.03em; color: #fff; }
  .cab .sub { margin: 0; max-width: 640px; color: #c3d0f2; font-size: .92rem; line-height: 1.55; }
  .eyebrow { display: block; font-size: .72rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: #8fb0ff; }
  .cab .btn { color: #fff; border-color: rgb(255 255 255 / .3); background: rgb(255 255 255 / .08); }
  .cab .btn.primary { color: var(--navy); border-color: transparent; background: #fff; box-shadow: none; }
  .cupo { display: flex; align-items: center; gap: 14px; }

  h2 { margin: 0 0 14px; font-size: 1.1rem; letter-spacing: -.01em; } h3 { margin: 0 0 8px; font-size: 1rem; } h4 { margin: 0 0 8px; font-size: .95rem; } h5 { margin: 0 0 8px; font-size: .82rem; color: var(--muted); }
  .sub, .nota { color: var(--muted); font-size: .88rem; line-height: 1.55; } .nota { margin: 4px 0 14px; }

  /* ---------- Avisos ---------- */
  p.ok, p.error, .banner { display: flex; align-items: center; gap: 10px; margin: 0 0 14px; padding: 12px 16px; border-radius: 12px; font-size: .9rem; }
  p.ok { background: #d1fae5; color: #047857; } p.error, .banner.bad { background: #fef2f2; color: #b91c1c; }

  /* ---------- Pestañas, filtros e indicadores ---------- */
  .tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 16px; border-bottom: 1px solid var(--line); }
  .tabs button { display: inline-flex; align-items: center; gap: 8px; padding: 12px 18px; border: 0; border-bottom: 2px solid transparent; background: none; font: inherit; color: var(--muted); cursor: pointer; transition: color .15s; }
  .tabs button:hover { color: #0f172a; } .tabs button.on { color: var(--brand); border-bottom-color: var(--brand); font-weight: 600; }
  span.num { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: var(--brand); color: #fff; font-size: .7rem; font-weight: 700; } span.num.bad { background: #ef4444; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; margin-bottom: 18px; }
  .kpi { position: relative; overflow: hidden; display: flex; flex-direction: column; gap: 2px; padding: 18px 20px 18px 24px; background: #fff; border: 1px solid var(--line); border-radius: 16px; }
  .kpi::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 5px; background: var(--brand); } .kpi.warn::before { background: #f59e0b; }
  .kpi b { font-size: 1.75rem; letter-spacing: -.03em; } .kpi span { color: var(--muted); font-size: .82rem; } .kpi.warn b { color: #b45309; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
  .chip { padding: 7px 16px; border: 1px solid var(--line); border-radius: 999px; background: #fff; color: var(--muted); font: inherit; font-size: .85rem; font-weight: 600; cursor: pointer; transition: .15s; }
  .chip:hover { border-color: #aebde3; } .chip.on { color: #fff; background: var(--navy); border-color: var(--navy); }

  /* ---------- Botones y formularios ---------- */
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 40px; padding: 0 16px; border: 1px solid var(--line); border-radius: 11px; background: #fff; color: #0f172a;
    font: inherit; font-size: .86rem; font-weight: 600; text-decoration: none; cursor: pointer; transition: border-color .15s, transform .15s, box-shadow .15s; }
  .btn:hover:not(:disabled) { border-color: #b5c2e0; transform: translateY(-1px); } .btn:disabled { opacity: .5; cursor: not-allowed; }
  .btn.primary { color: #fff; border-color: transparent; background: linear-gradient(135deg, #1d4ed8, #2f6bff); box-shadow: 0 10px 22px -12px rgb(29 78 216 / .8); }
  .btn.peligro { color: #b91c1c; margin-left: auto; } .btn.peligro:hover:not(:disabled) { background: #fef2f2; border-color: #fecaca; }
  input:not([type=checkbox]), select, textarea { padding: 9px 12px; border: 1px solid #cbd5e1; border-radius: 10px; font: inherit; font-size: .9rem; background: #fff; color: #0f172a; transition: border-color .15s, box-shadow .15s; }
  input:not([type=checkbox]), select { height: 40px; } textarea { width: 100%; resize: vertical; }
  input:focus, select:focus, textarea:focus { outline: 0; border-color: var(--brand); box-shadow: 0 0 0 4px rgb(29 78 216 / .12); }
  input:disabled { background: #f1f5f9; } input[type=checkbox] { width: 17px; height: 17px; accent-color: var(--brand); }
  label { display: flex; flex-direction: column; gap: 6px; font-size: .82rem; font-weight: 600; color: #334155; } label small { font-weight: 400; color: var(--muted); }
  .chk { display: inline-flex; flex-direction: row; align-items: center; gap: 8px; font-weight: 500; white-space: nowrap; }
  .full { grid-column: 1 / -1; }

  /* ---------- Tablas ---------- */
  .tabla-wrap { overflow-x: auto; background: #fff; border: 1px solid var(--line); border-radius: 16px; }
  .tabla { width: 100%; border-collapse: collapse; font-size: .88rem; }
  .tabla th, .tabla td { padding: 13px 16px; text-align: left; vertical-align: top; border-bottom: 1px solid #eef1f8; }
  .tabla th { font-size: .7rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); background: #f8faff; }
  .tabla tbody tr:hover td { background: #fafcff; } .tabla tr:last-child td { border-bottom: 0; } .tabla tr.off td { opacity: .55; }
  .tabla small { display: block; color: var(--muted); } .tabla ul { margin: 0 0 4px; padding-left: 16px; } .acc { color: var(--muted); font-size: .82rem; max-width: 280px; }
  .btns { text-align: right; } .btns .btn { height: 36px; margin: 0 0 6px 6px; }
  .sub-chip { display: flex; align-items: center; gap: 6px; width: fit-content; padding: 3px 10px; border-radius: 999px; background: #d1fae5; color: #047857; font-size: .75rem; font-weight: 600; }
  .sub-chip + .sub-chip { margin-top: 6px; } .sub-chip.pronto { background: #fef3c7; color: #b45309; } .sub-chip.venc { background: #fee2e2; color: #b91c1c; }
  .x { border: 0; background: none; color: inherit; font-size: 1rem; line-height: 1; cursor: pointer; padding: 0; }
  .extra td { background: #f8faff; } .renovar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .vacio { padding: 36px; text-align: center; color: var(--muted); } .vacio-b { grid-column: 1 / -1; padding: 40px 0; text-align: center; color: var(--muted); }
  .nw { white-space: nowrap; } .ct { display: flex !important; align-items: center; gap: 6px; } .id { font-family: ui-monospace, monospace; }
  .estado { padding: 3px 10px; border-radius: 999px; background: #f1f5f9; color: #475569; font-size: .72rem; font-weight: 700; white-space: nowrap; }
  .estado.ok { background: #d1fae5; color: #047857; } .estado.bad { background: #fee2e2; color: #b91c1c; }
  .rol { padding: 3px 10px; border-radius: 999px; background: #f1f5f9; color: #475569; font-size: .75rem; font-weight: 600; } .r-admin { background: var(--soft); color: var(--brand); } .r-cotizador { background: #d1fae5; color: #047857; }

  /* ---------- Tarjetas ---------- */
  .planes { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 16px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  .plan, .card { display: flex; flex-direction: column; gap: 12px; padding: 20px; background: #fff; border: 1px solid var(--line); border-radius: 16px; transition: border-color .2s, box-shadow .2s; }
  .card { margin-bottom: 14px; } .cards .card { margin-bottom: 0; }
  .plan:hover, .card:hover { border-color: #c3cde6; box-shadow: 0 20px 40px -30px rgb(10 26 58 / .5); }
  .card.nuevo { background: #fafbff; border-style: dashed; } .card.nuevo:hover { box-shadow: none; }
  .card.nuevo.nuevo { border-color: #c3cde6; } .cards .card.nuevo { border-style: solid; border-color: #a5b4fc; box-shadow: 0 0 0 3px var(--soft); }
  .card .chip { cursor: default; padding: 3px 10px; font-size: .72rem; color: var(--brand); background: var(--soft); border-color: transparent; }
  .c-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; } .c-top h3 { line-height: 1.35; } .c-top small { color: var(--muted); }
  .datos { display: flex; flex-direction: column; gap: 4px; font-size: .86rem; color: #334155; } .datos span { display: flex; align-items: center; gap: 8px; }
  .msg { margin: 0; padding: 10px 12px; border-radius: 10px; background: #f8f9fc; font-size: .86rem; color: #334155; }
  label.est { margin-top: auto; gap: 4px; font-size: .78rem; color: var(--muted); }
  .plan-cab { display: flex; gap: 10px; align-items: center; } .plan-nombre { flex: 1; font-weight: 600; }
  .venta { flex-direction: row; align-items: center; gap: 6px; font-size: .85rem; font-weight: 500; white-space: nowrap; }
  .fila { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; } .acciones { padding-top: 12px; border-top: 1px solid #eef1f8; }
  .grande { flex: 1; min-width: 200px; font-weight: 600; } .cod { margin-left: auto; font-size: .72rem; color: #94a3b8; }
  .mods { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; font-size: .85rem; } label.num { gap: 6px; }
  .dos { display: grid; grid-template-columns: 1.2fr 1fr; gap: 18px; }
  .mini, .precios { width: 100%; border-collapse: collapse; font-size: .82rem; } .mini th, .mini td, .precios th, .precios td { padding: 5px; text-align: left; } .mini input, .precios input { width: 100%; }
  .benef { display: flex; flex-direction: column; gap: 6px; } .b-fila { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: .84rem; } .corto { width: 90px; }

  /* ---------- Formularios largos y ventanas ---------- */
  .form { display: flex; flex-direction: column; gap: 12px; max-width: 780px; padding: 24px; background: #fff; border: 1px solid var(--line); border-radius: 18px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .subs-form { display: flex; flex-direction: column; gap: 8px; } .sub-fila { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 8px; align-items: center; }
  .overlay { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 16px; background: rgb(10 26 58 / .55); overflow-y: auto; }
  .modal { width: min(680px, 100%); display: flex; flex-direction: column; gap: 12px; padding: 24px; background: #fff; border-radius: 18px; box-shadow: 0 40px 90px -30px rgb(0 0 0 / .6); }
  .modal h3, .modal h4 { margin: 0; }
  .matriz { width: 100%; border-collapse: collapse; font-size: .85rem; } .matriz th, .matriz td { padding: 8px; border: 1px solid #eef1f8; text-align: center; }
  .matriz td:first-child, .matriz th:first-child { text-align: left; } .pie { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }

  @media (max-width: 800px) { .dos, .grid2, .sub-fila { grid-template-columns: 1fr; } .cab { padding: 22px; } }
`;