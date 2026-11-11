import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { IconComponent } from '../../shared/icon.component';

export interface SesionAgenda {
  id: number; inicio: string; fin: string; estado: 'programada' | 'realizada' | 'no_asistio' | 'cancelada';
  asesor: string; enlace: string; servicio: string;
}

const ZONA = 'America/Lima';
const NOMBRES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const ESTADO: Record<string, string> = { programada: 'Programada', realizada: 'Realizada', no_asistio: 'No asististe', cancelada: 'Cancelada' };

const hoyISO = (): string => new Date().toLocaleDateString('en-CA', { timeZone: ZONA });
const diaDe = (iso: string): string => new Date(iso).toLocaleDateString('en-CA', { timeZone: ZONA });
const fechaIcs = (iso: string): string => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const escIcs = (t: string): string => t.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

@Component({
  selector: 'app-mi-calendario',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="mc">
      <div class="mc-cab">
        <div class="nav">
          <button type="button" class="btn ico" aria-label="Mes anterior" (click)="cambiar(-1)"><app-icon name="left" [size]="16" /></button>
          <b class="tit">{{ titulo() }}</b>
          <button type="button" class="btn ico" aria-label="Mes siguiente" (click)="cambiar(1)"><app-icon name="right" [size]="16" /></button>
          <button type="button" class="btn" (click)="irHoy()">Hoy</button>
        </div>
        <button type="button" class="btn" [disabled]="!proximas().length" (click)="descargar(proximas(), 'mis-sesiones.ics')">
          <app-icon name="calendar" [size]="15" /> Descargar mi calendario (.ics)
        </button>
      </div>

      <div class="sem">@for (n of nombres; track n) { <span>{{ n }}</span> }</div>
      <div class="mes">
        @for (c of celdas(); track c.clave) {
          <button type="button" class="dia" [class.fuera]="c.fuera" [class.hoy]="c.clave === hoy()" [class.sel]="c.clave === sel()" (click)="sel.set(c.clave)">
            <span class="n">{{ c.num }}</span>
            @for (s of delDia(c.clave).slice(0, 2); track s.id) {
              <span class="pil" [class.hecha]="s.estado === 'realizada'" [class.falta]="s.estado === 'no_asistio'">{{ hora(s.inicio) }}</span>
            }
            @if (delDia(c.clave).length > 2) { <small>+{{ delDia(c.clave).length - 2 }} más</small> }
          </button>
        }
      </div>

      <div class="det">
        @for (s of selLista(); track s.id) {
          <article class="item">
            <div class="i-top">
              <b>{{ hora(s.inicio) }} a {{ hora(s.fin) }}</b>
              <span class="estado" [class.ok]="s.estado === 'realizada'" [class.azul]="s.estado === 'programada'" [class.bad]="s.estado === 'no_asistio'">{{ estadoTxt(s.estado) }}</span>
            </div>
            <span>{{ s.servicio }} · con {{ s.asesor }}</span>
            @if (s.estado === 'programada') {
              <div class="i-acc">
                @if (s.enlace) { <a class="btn primary" [href]="s.enlace" target="_blank" rel="noopener"><app-icon name="video" [size]="15" /> Abrir sala</a> }
                <a class="btn" [href]="urlGoogle(s)" target="_blank" rel="noopener">Agregar a Google Calendar</a>
                <button type="button" class="btn" (click)="descargar([s], 'sesion.ics')">Apple / Outlook (.ics)</button>
              </div>
            }
          </article>
        } @empty { <p class="vacio">No tienes sesiones este día.</p> }
      </div>
    </section>
  `,
  styles: [`
    :host { display: block; color: #0f172a; --brand: #1d4ed8; --line: #e2e8f4; --muted: #5a6784; --soft: #eef2ff; }
    * { box-sizing: border-box; }
    .mc { padding: 18px; background: #fff; border: 1px solid var(--line); border-radius: 18px; margin-bottom: 18px; }
    .mc-cab { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; } .nav { display: flex; align-items: center; gap: 8px; } .tit { min-width: 150px; text-align: center; text-transform: capitalize; font-size: 1.05rem; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 38px; padding: 0 14px; border: 1px solid var(--line); border-radius: 10px; background: #fff; color: #0f172a; font: inherit; font-size: .84rem; font-weight: 600; text-decoration: none; cursor: pointer; }
    .btn.ico { width: 38px; padding: 0; } .btn:hover:not(:disabled) { border-color: #b5c2e0; } .btn:disabled { opacity: .5; cursor: not-allowed; } .btn.primary { color: #fff; border-color: transparent; background: linear-gradient(135deg, #1d4ed8, #2f6bff); }
    .sem, .mes { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; } .sem { margin-bottom: 4px; } .sem span { text-align: center; font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
    .dia { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; min-height: 74px; padding: 6px; border: 1px solid #eef1f8; border-radius: 10px; background: #fff; font: inherit; text-align: left; cursor: pointer; }
    .dia:hover { border-color: #b5c2e0; } .dia.fuera { opacity: .4; } .dia.sel { border-color: var(--brand); background: var(--soft); } .n { font-size: .82rem; font-weight: 600; }
    .dia.hoy .n { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; color: #fff; background: var(--brand); }
    .pil { padding: 1px 7px; border-radius: 999px; background: #dbeafe; color: #1d4ed8; font-size: .7rem; font-weight: 700; } .pil.hecha { background: #d1fae5; color: #047857; } .pil.falta { background: #fee2e2; color: #b91c1c; } .dia small { color: var(--muted); font-size: .68rem; }
    .det { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line); }
    .item { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; } .item > span { color: #334155; font-size: .88rem; }
    .i-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; } .i-acc { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; } .vacio { margin: 0; color: var(--muted); font-size: .88rem; }
    .estado { padding: 3px 10px; border-radius: 999px; background: #f1f5f9; color: #475569; font-size: .72rem; font-weight: 700; } .estado.ok { background: #d1fae5; color: #047857; } .estado.azul { background: #dbeafe; color: #1d4ed8; } .estado.bad { background: #fee2e2; color: #b91c1c; }
    @media (max-width: 600px) { .dia { min-height: 58px; padding: 4px; } .pil { font-size: .62rem; padding: 1px 5px; } }
  `],
})
export class MiCalendarioComponent {
  readonly sesiones = input<SesionAgenda[]>([]);
  readonly nombres = NOMBRES;
  readonly hoy = signal<string>(hoyISO());
  readonly mes = signal<string>(hoyISO().slice(0, 7));
  readonly sel = signal<string>(hoyISO());

  readonly titulo = computed<string>(() => {
    const [y, m] = this.mes().split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('es-PE', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  });

  readonly celdas = computed(() => {
    const [y, m] = this.mes().split('-').map(Number);
    const desfase = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(Date.UTC(y, m - 1, 1 - desfase + i));
      return { clave: d.toISOString().slice(0, 10), num: d.getUTCDate(), fuera: d.getUTCMonth() !== m - 1 };
    });
  });

  readonly porDia = computed(() => {
    const mapa = new Map<string, SesionAgenda[]>();
    for (const s of this.sesiones()) { const k = diaDe(s.inicio); mapa.set(k, [...(mapa.get(k) ?? []), s]); }
    return mapa;
  });
  readonly selLista = computed<SesionAgenda[]>(() => this.porDia().get(this.sel()) ?? []);
  readonly proximas = computed<SesionAgenda[]>(() => this.sesiones().filter((s) => s.estado === 'programada' && new Date(s.fin).getTime() > Date.now()));

  delDia(clave: string): SesionAgenda[] { return this.porDia().get(clave) ?? []; }
  estadoTxt(e: string): string { return ESTADO[e] ?? e; }
  hora(iso: string): string { return new Date(iso).toLocaleTimeString('es-PE', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hour12: false }); }

  cambiar(n: number): void {
    const [y, m] = this.mes().split('-').map(Number);
    this.mes.set(new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7));
  }
  irHoy(): void { this.mes.set(hoyISO().slice(0, 7)); this.sel.set(hoyISO()); this.hoy.set(hoyISO()); }

  /** Enlace para agregar la sesión a Google Calendar. */
  urlGoogle(s: SesionAgenda): string {
    const q = new URLSearchParams({
      action: 'TEMPLATE', text: `Sesión: ${s.servicio}`, dates: `${fechaIcs(s.inicio)}/${fechaIcs(s.fin)}`,
      details: `Asesor: ${s.asesor}${s.enlace ? `\nSala: ${s.enlace}` : ''}`, location: s.enlace,
    });
    return `https://calendar.google.com/calendar/render?${q.toString()}`;
  }

  /** Archivo .ics para Apple Calendar, Outlook y cualquier otro calendario. */
  descargar(lista: SesionAgenda[], nombre: string): void {
    const ahora = fechaIcs(new Date().toISOString());
    const eventos = lista.flatMap((s) => [
      'BEGIN:VEVENT', `UID:sesion-${s.id}@coti`, `DTSTAMP:${ahora}`, `DTSTART:${fechaIcs(s.inicio)}`, `DTEND:${fechaIcs(s.fin)}`,
      `SUMMARY:${escIcs(`Sesión: ${s.servicio}`)}`,
      `DESCRIPTION:${escIcs(`Asesor: ${s.asesor}${s.enlace ? `\nSala: ${s.enlace}` : ''}`)}`,
      ...(s.enlace ? [`URL:${s.enlace}`] : []), 'END:VEVENT',
    ]);
    const texto = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//COTI//Sesiones//ES', 'CALSCALE:GREGORIAN', ...eventos, 'END:VCALENDAR'].join('\r\n');
    const url = URL.createObjectURL(new Blob([texto], { type: 'text/calendar;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    a.click();
    URL.revokeObjectURL(url);
  }
}