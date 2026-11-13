import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { TiempoRealService } from '../../core/tiempo-real.service';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import { IconComponent } from '../../shared/icon.component';
import { CrmLeadComponent } from './crm-lead.component';
import { CrmConexionesComponent } from './crm-conexiones.component';
import { AsesorCrm, CrmService, Etapa, Lead, ResultadoImport, Resumen } from './crm.service';

type Vista = 'tablero' | 'lista' | 'config' | 'conexiones';

interface NuevoLeadForm {
  nombre: string;
  empresa_nombre: string;
  telefono: string;
  correo: string;
  interes: string;
  valor_estimado: string;
  asesor_id: string;
}

const ZONA = 'America/Lima';
const LIMITE = 500;
const ORIGEN: Record<string, string> = {
  manual: 'Manual', importado: 'Importado', pedido_whatsapp: 'Pedido WhatsApp', cotizacion: 'Cotización', whatsapp: 'WhatsApp',
  facebook: 'Facebook', instagram: 'Instagram', web: 'Web',
};
const sinAcentos = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const SINONIMOS: Record<string, string> = {
  nombre: 'nombre', name: 'nombre', cliente: 'nombre', empresa: 'empresa', company: 'empresa', razonsocial: 'empresa',
  correo: 'correo', email: 'correo', mail: 'correo', telefono: 'telefono', celular: 'telefono', phone: 'telefono', whatsapp: 'telefono', movil: 'telefono',
  interes: 'interes', producto: 'interes', servicio: 'interes', valor: 'valor', monto: 'valor', importe: 'valor',
};

/** Lector de CSV: respeta comillas y detecta si el separador es coma o punto y coma (Excel en español usa ;). */
function leerCsv(texto: string): Record<string, string>[] {
  const lineas = texto.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lineas.length < 2) return [];
  const sep = (lineas[0].match(/;/g)?.length ?? 0) > (lineas[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const partir = (l: string): string[] => {
    const out: string[] = []; let cur = ''; let q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (c === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === sep && !q) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map((x) => x.trim());
  };
  const cab = partir(lineas[0]).map((h) => SINONIMOS[sinAcentos(h).replace(/[^a-z]/g, '')] ?? '');
  return lineas.slice(1).map((l) => {
    const celdas = partir(l);
    const fila: Record<string, string> = {};
    cab.forEach((k, i) => { if (k && celdas[i] !== undefined) fila[k] = celdas[i]; });
    return fila;
  }).filter((f) => Object.keys(f).length > 0);
}

@Component({
  selector: 'app-crm-panel',
  imports: [IconComponent, CrmLeadComponent, CrmConexionesComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (mensaje()) { <p class="ok"><app-icon name="circle-check" [size]="18" /> {{ mensaje() }}</p> }
    @if (error()) { <p class="error"><app-icon name="alert" [size]="18" /> {{ error() }}</p> }

    <div class="barra">
      <div class="tabs vistas">
        <button type="button" [class.on]="vista() === 'tablero'" (click)="vista.set('tablero')">Tablero</button>
        <button type="button" [class.on]="vista() === 'lista'" (click)="vista.set('lista')">Lista</button>
        @if (esAdmin()) {
          <button type="button" [class.on]="vista() === 'conexiones'" (click)="vista.set('conexiones')">Conexiones</button>
          <button type="button" [class.on]="vista() === 'config'" (click)="irConfig()">Configuración</button>
        }
      </div>
      <div class="acc">
        <button type="button" class="btn" (click)="abrirImport()">Importar CSV</button>
        <button type="button" class="btn primary" (click)="abrirNuevo()"><app-icon name="plus" [size]="16" /> Nuevo lead</button>
      </div>
    </div>

    @if (vista() === 'tablero' || vista() === 'lista') {
      @if (resumen(); as r) {
        <div class="kpis">
          <div class="kpi"><small>Abiertos</small><b>{{ r.abiertos }}</b></div>
          <div class="kpi"><small>Valor en juego</small><b>{{ soles(r.valor_abierto) }}</b></div>
          <div class="kpi" [class.alerta]="r.vencidos > 0"><small>Seguimientos vencidos</small><b>{{ r.vencidos }}</b></div>
          @if (esAdmin()) { <div class="kpi" [class.alerta]="r.sin_asignar > 0"><small>Sin asignar</small><b>{{ r.sin_asignar }}</b></div> }
          <div class="kpi"><small>Ganados este mes</small><b>{{ r.ganados_mes }} · {{ soles(r.valor_ganado_mes) }}</b></div>
        </div>
      }
      <div class="filtros">
        <input class="buscar" type="search" placeholder="Buscar por nombre, empresa, correo o teléfono" [value]="q()" (input)="buscar($any($event.target).value)" />
        @if (esAdmin()) {
          <select aria-label="Filtrar por ejecutivo" (change)="filtrarAsesor($any($event.target).value)">
            <option value="" [selected]="fAsesor() === null">Todos los ejecutivos</option>
            <option value="0" [selected]="fAsesor() === 0">Sin asignar</option>
            @for (a of asesores(); track a.id) { <option [value]="a.id" [selected]="fAsesor() === a.id">{{ a.nombre }} ({{ a.leads }})</option> }
          </select>
        }
        <label class="chk"><input type="checkbox" [checked]="vencidos()" (change)="alternarVencidos($any($event.target).checked)" /> Solo seguimiento vencido</label>
      </div>
    }

    @switch (vista()) {
      @case ('tablero') {
        <div class="tablero">
          @for (e of etapasActivas(); track e.id) {
            <section class="col" (dragover)="$event.preventDefault()" (drop)="soltar(e)">
              <header [style.border-top-color]="e.color">
                <b>{{ e.nombre }}</b><span class="n">{{ total(e) }}</span>
                <small>{{ soles(valor(e)) }}</small>
              </header>
              @for (l of lista(e); track l.id) {
                <article class="tarjeta" draggable="true" (dragstart)="arrastrar(l)" (click)="abrir(l.id)" [class.venc]="l.vencido">
                  <b>{{ l.nombre }}</b>
                  @if (l.wa_no_leidos > 0) { <span class="nuevo">{{ l.wa_no_leidos }} sin leer</span> }
                  @if (l.empresa_nombre) { <small>{{ l.empresa_nombre }}</small> }
                  @if (l.interes) { <small class="int">{{ l.interes }}</small> }
                  <div class="pie-t">
                    <span class="tag">{{ origen(l.origen) }}</span>
                    @if (l.valor_estimado > 0) { <span class="val">{{ soles(l.valor_estimado) }}</span> }
                  </div>
                  <div class="pie-t">
                    @if (esAdmin()) { <span class="asesor" [style.background]="l.asesor_color ?? '#94a3b8'">{{ l.asesor ?? 'Sin asignar' }}</span> }
                    @if (l.siguiente_accion_en) { <small [class.rojo]="l.vencido">{{ fechaCorta(l.siguiente_accion_en) }}</small> }
                  </div>
                </article>
              } @empty { <p class="vacio-col">Sin leads</p> }
            </section>
          }
        </div>
      }

      @case ('lista') {
        <div class="tabla-wrap">
          <table class="tabla">
            <thead><tr><th>Lead</th><th>Contacto</th><th>Etapa</th><th>Origen</th>@if (esAdmin()) { <th>Ejecutivo</th> }<th>Valor</th><th>Próxima acción</th></tr></thead>
            <tbody>
              @for (l of abiertos(); track l.id) {
                <tr class="fila-click" (click)="abrir(l.id)">
                  <td><b>{{ l.nombre }}</b>@if (l.wa_no_leidos > 0) { <span class="nuevo">{{ l.wa_no_leidos }} sin leer</span> }<small>{{ l.empresa_nombre }}</small></td>
                  <td><small>{{ l.telefono ? '+' + l.telefono : '' }}</small><small>{{ l.correo }}</small></td>
                  <td><span class="etp" [style.background]="colorEtapa(l.etapa_id)">{{ nombreEtapa(l.etapa_id) }}</span></td>
                  <td>{{ origen(l.origen) }}</td>
                  @if (esAdmin()) { <td>{{ l.asesor ?? 'Sin asignar' }}</td> }
                  <td>{{ l.valor_estimado > 0 ? soles(l.valor_estimado) : '—' }}</td>
                  <td [class.rojo]="l.vencido">{{ l.siguiente_accion_en ? fechaCorta(l.siguiente_accion_en) : '—' }}</td>
                </tr>
              } @empty { <tr><td [attr.colspan]="esAdmin() ? 7 : 6" class="vacio">No hay leads abiertos con estos filtros.</td></tr> }
            </tbody>
          </table>
        </div>
        @if (hayMas()) { <div class="fila"><button type="button" class="btn" (click)="masAbiertos()">Cargar más</button></div> }
      }

      @case ('conexiones') { <app-crm-conexiones /> }

      @case ('config') {
        @if (cfg(); as c) {
          <section class="card">
            <h3>Reparto de leads nuevos</h3>
            <div class="modos">
              <button type="button" class="modo" [class.on]="reparto() === 'manual'" (click)="reparto.set('manual')"><b>Manual</b><small>Llegan «sin asignar» y tú los repartes.</small></button>
              <button type="button" class="modo" [class.on]="reparto() === 'rotativo'" (click)="reparto.set('rotativo')"><b>Rotativo</b><small>Cada lead nuevo va al siguiente ejecutivo de ventas activo con acceso al CRM y con el reparto encendido.</small></button>
            </div>
          </section>
          <section class="card">
            <h3>Etapas del embudo</h3>
            <p class="nota">Arrastra el orden con las flechas. Una etapa con leads no se puede desactivar. Siempre debe haber al menos una de cada tipo: abierta, ganado y perdido.</p>
            <ul class="etapas">
              @for (e of etapasCfg(); track $index; let i = $index) {
                <li>
                  <input type="color" [value]="e.color" (input)="editarEtapa(i, 'color', $any($event.target).value)" aria-label="Color" />
                  <input class="nom" maxlength="40" [value]="e.nombre" (input)="editarEtapa(i, 'nombre', $any($event.target).value)" />
                  <span class="tipo-e">{{ e.tipo === 'abierta' ? 'Abierta' : (e.tipo === 'ganada' ? 'Ganado' : 'Perdido') }}</span>
                  <small>{{ e.leads ?? 0 }} leads</small>
                  <label class="chk"><input type="checkbox" [checked]="e.activa" (change)="editarEtapa(i, 'activa', $any($event.target).checked)" /> Activa</label>
                  <button type="button" class="btn ico" aria-label="Subir" [disabled]="i === 0" (click)="subir(i, -1)"><app-icon name="arrow-up" [size]="14" /></button>
                  <button type="button" class="btn ico" aria-label="Bajar" [disabled]="i === etapasCfg().length - 1" (click)="subir(i, 1)"><app-icon name="arrow-down" [size]="14" /></button>
                </li>
              }
            </ul>
            <div class="fila acciones">
              <button type="button" class="btn" (click)="nuevaEtapa()"><app-icon name="plus" [size]="15" /> Agregar etapa abierta</button>
              <button type="button" class="btn primary" (click)="guardarConfig()">Guardar configuración</button>
            </div>
          </section>
        }
      }
    }

    @if (abierto(); as id) {
      <app-crm-lead [id]="id" [etapas]="etapas()" [asesores]="asesores()" [esAdmin]="esAdmin()" (cerrar)="abierto.set(null)" (cambio)="recargar()" />
    }

    @if (perdida(); as p) {
      <div class="overlay" (click)="perdida.set(null)">
        <div class="modal" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <h3>¿Por qué se perdió «{{ p.lead.nombre }}»?</h3>
          <textarea rows="3" maxlength="200" placeholder="Por ejemplo: eligió a la competencia, sin presupuesto, no responde" [value]="motivo()" (input)="motivo.set($any($event.target).value)"></textarea>
          <div class="pie">
            <button type="button" class="btn" (click)="perdida.set(null)">Cancelar</button>
            <button type="button" class="btn peligro" [disabled]="!motivo().trim()" (click)="confirmarPerdida()">Marcar como perdido</button>
          </div>
        </div>
      </div>
    }

    @if (nuevo()) {
      <div class="overlay" (click)="nuevo.set(false)">
        <div class="modal" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <header class="m-cab"><h3>Nuevo lead</h3><button type="button" class="btn ico" aria-label="Cerrar" (click)="nuevo.set(false)"><app-icon name="x" [size]="18" /></button></header>
          <div class="grid2">
            <label>Nombre <input [value]="nl().nombre" (input)="campoNuevo('nombre', $any($event.target).value)" /></label>
            <label>Empresa <input [value]="nl().empresa_nombre" (input)="campoNuevo('empresa_nombre', $any($event.target).value)" /></label>
            <label>Teléfono / WhatsApp <input placeholder="999 888 777" [value]="nl().telefono" (input)="campoNuevo('telefono', $any($event.target).value)" /></label>
            <label>Correo <input type="email" [value]="nl().correo" (input)="campoNuevo('correo', $any($event.target).value)" /></label>
            <label>Interés <input placeholder="Qué busca" [value]="nl().interes" (input)="campoNuevo('interes', $any($event.target).value)" /></label>
            <label>Valor estimado (S/) <input type="number" min="0" [value]="nl().valor_estimado" (input)="campoNuevo('valor_estimado', $any($event.target).value)" /></label>
            @if (esAdmin()) {
              <label>Ejecutivo
                <select (change)="campoNuevo('asesor_id', $any($event.target).value)">
                  <option value="">Según el reparto</option>
                  @for (a of asesores(); track a.id) { <option [value]="a.id">{{ a.nombre }}</option> }
                </select>
              </label>
            }
          </div>
          @if (errorModal()) { <p class="error">{{ errorModal() }}</p> }
          <div class="pie">
            <button type="button" class="btn" (click)="nuevo.set(false)">Cancelar</button>
            <button type="button" class="btn primary" (click)="crear()">Crear lead</button>
          </div>
        </div>
      </div>
    }

    @if (importar()) {
      <div class="overlay" (click)="importar.set(false)">
        <div class="modal" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <header class="m-cab"><h3>Importar leads desde CSV</h3><button type="button" class="btn ico" aria-label="Cerrar" (click)="importar.set(false)"><app-icon name="x" [size]="18" /></button></header>
          <p class="nota">En Excel: Archivo → Guardar como → CSV. La primera fila debe tener los títulos: <b>nombre</b>, empresa, correo, <b>telefono</b>, interes, valor. Cada fila necesita nombre y teléfono o correo. Hasta 500 filas por vez; los repetidos se saltan.</p>
          <input type="file" accept=".csv,text/csv" (change)="leerArchivo($any($event.target).files)" />
          @if (csv().length) { <p class="ok">Se leyeron {{ csv().length }} filas listas para importar.</p> }
          @if (resImport(); as r) {
            <div class="res">
              <p><b>{{ r.creados }}</b> creados · {{ r.duplicados }} repetidos · {{ r.invalidos }} con problemas</p>
              @for (e of r.errores; track $index) { <small>{{ e }}</small> }
            </div>
          }
          @if (errorModal()) { <p class="error">{{ errorModal() }}</p> }
          <div class="pie">
            <button type="button" class="btn" (click)="importar.set(false)">Cerrar</button>
            <button type="button" class="btn primary" [disabled]="!csv().length" (click)="ejecutarImport()">Importar</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [ESTILOS_ADMIN, `
    .barra { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; } .acc { display: flex; gap: 8px; flex-wrap: wrap; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 14px; }
    .kpi { padding: 14px 16px; background: #fff; border: 1px solid var(--line); border-radius: 14px; display: flex; flex-direction: column; gap: 2px; } .kpi small { color: var(--muted); } .kpi b { font-size: 1.25rem; } .kpi.alerta { border-color: #fecaca; background: #fef2f2; } .kpi.alerta b { color: #b91c1c; }
    .filtros { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 14px; } .buscar { flex: 1; min-width: 240px; }
    .chk { display: flex; flex-direction: row; align-items: center; gap: 8px; font-weight: 600; cursor: pointer; } .chk input { width: 17px; height: 17px; accent-color: var(--brand); }
    .tablero { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 14px; align-items: flex-start; }
    .col { flex: 0 0 280px; background: #f4f6fb; border-radius: 14px; padding: 10px; display: flex; flex-direction: column; gap: 8px; min-height: 140px; }
    .col header { display: flex; align-items: center; gap: 8px; padding: 8px 8px 6px; border-top: 4px solid; border-radius: 6px; background: #fff; flex-wrap: wrap; } .col header .n { margin-left: auto; padding: 1px 9px; border-radius: 999px; background: #e8edf8; font-size: .78rem; font-weight: 700; } .col header small { width: 100%; color: var(--muted); }
    .tarjeta { display: flex; flex-direction: column; gap: 4px; padding: 11px 12px; background: #fff; border: 1px solid var(--line); border-radius: 12px; cursor: grab; box-shadow: 0 1px 2px rgb(10 26 58 / .06); } .tarjeta:hover { border-color: #b5c2e0; } .tarjeta:active { cursor: grabbing; opacity: .7; } .tarjeta.venc { border-left: 4px solid #ef4444; }
    .tarjeta small { color: var(--muted); } .tarjeta .int { font-style: italic; } .pie-t { display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-wrap: wrap; }
    .tag { padding: 1px 8px; border-radius: 999px; background: #eef2ff; color: #4338ca; font-size: .7rem; font-weight: 700; } .val { font-weight: 700; font-size: .82rem; }
    .asesor { padding: 1px 8px; border-radius: 999px; color: #fff; font-size: .7rem; font-weight: 700; } .rojo { color: #b91c1c !important; font-weight: 700; }
    .nuevo { align-self: flex-start; padding: 1px 9px; border-radius: 999px; background: #25d366; color: #fff; font-size: .7rem; font-weight: 700; }
    .vacio-col { margin: 6px 0; text-align: center; color: var(--muted); font-size: .82rem; }
    .fila-click { cursor: pointer; } .fila-click:hover { background: #f8faff; } .etp { padding: 2px 10px; border-radius: 999px; color: #fff; font-size: .74rem; font-weight: 700; }
    .modos { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    .modo { display: flex; flex-direction: column; gap: 4px; padding: 14px; text-align: left; border: 2px solid var(--line); border-radius: 14px; background: #fff; font: inherit; cursor: pointer; } .modo small { color: var(--muted); } .modo.on { border-color: var(--brand); background: var(--soft); }
    .etapas { list-style: none; margin: 12px 0; padding: 0; display: flex; flex-direction: column; gap: 8px; } .etapas li { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--line); border-radius: 12px; background: #fff; }
    .etapas .nom { flex: 1; min-width: 160px; } .etapas input[type='color'] { width: 38px; height: 34px; padding: 2px; } .tipo-e { padding: 2px 10px; border-radius: 999px; background: #f1f5f9; font-size: .74rem; font-weight: 700; color: #475569; }
    textarea { width: 100%; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 12px; font: inherit; resize: vertical; } .res { margin-top: 10px; padding: 10px 14px; background: #f8faff; border-radius: 12px; display: flex; flex-direction: column; gap: 3px; } .res p { margin: 0; }
  `],
})
export class CrmPanelComponent implements OnInit {
  private readonly api: CrmService = inject(CrmService);
  private readonly rt: TiempoRealService = inject(TiempoRealService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);
  readonly esAdmin = input<boolean>(false);

  readonly vista = signal<Vista>('tablero');
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');
  readonly errorModal = signal<string>('');
  readonly etapas = signal<Etapa[]>([]);
  readonly leads = signal<Lead[]>([]);          // abiertos + últimos ganados/perdidos (para el tablero)
  readonly resumen = signal<Resumen | null>(null);
  readonly asesores = signal<AsesorCrm[]>([]);
  readonly q = signal<string>('');
  readonly fAsesor = signal<number | null>(null);
  readonly vencidos = signal<boolean>(false);
  readonly abierto = signal<number | null>(null);
  readonly hayMas = signal<boolean>(false);
  private desde = 0;
  private temporizador = 0;
  private arrastrado: Lead | null = null;

  readonly etapasActivas = computed<Etapa[]>(() => this.etapas().filter((e) => e.activa));
  readonly abiertos = computed<Lead[]>(() => this.leads().filter((l) => l.estado === 'abierto'));

  // Perdido, nuevo lead, importar y configuración
  readonly perdida = signal<{ lead: Lead; etapa: Etapa } | null>(null);
  readonly motivo = signal<string>('');
readonly nuevo = signal<boolean>(false);

readonly nl = signal<NuevoLeadForm>({
  nombre: '',
  empresa_nombre: '',
  telefono: '',
  correo: '',
  interes: '',
  valor_estimado: '0',
  asesor_id: ''
});

readonly importar = signal<boolean>(false);
  readonly csv = signal<Record<string, string>[]>([]);
  readonly resImport = signal<ResultadoImport | null>(null);
  readonly cfg = signal<{ reparto: string } | null>(null);
  readonly reparto = signal<'manual' | 'rotativo'>('manual');
  readonly etapasCfg = signal<Etapa[]>([]);

  ngOnInit(): void {
    this.api.etapas().subscribe({ next: (e) => { this.etapas.set(e); this.recargar(); }, error: (er: HttpErrorResponse) => this.fallo(er) });
    if (this.esAdmin()) this.api.asesores().subscribe({ next: (a) => this.asesores.set(a), error: () => undefined });
    // Tiempo real: cualquier cambio de leads (míos o de otros) se refleja sin recargar
    this.rt.cambios('crm').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => { this.recargar(); if (this.esAdmin()) this.api.asesores().subscribe({ next: (a) => this.asesores.set(a), error: () => undefined }); });
  }

  // ---------------- Utilidades ----------------
  private ok(t: string): void { this.error.set(''); this.mensaje.set(t); }
  private fallo(e: HttpErrorResponse): void {
    this.mensaje.set('');
    const d = e.error?.detail;
    this.error.set(typeof d === 'string' ? d : 'No se pudo conectar con el servidor');
  }
  soles(n: number): string { return `S/ ${n.toLocaleString('es-PE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`; }
  origen(o: string): string { return ORIGEN[o] ?? o; }
  fechaCorta(iso: string): string { return new Date(iso).toLocaleString('es-PE', { timeZone: ZONA, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }); }
  nombreEtapa(id: number): string { return this.etapas().find((e) => e.id === id)?.nombre ?? ''; }
  colorEtapa(id: number): string { return this.etapas().find((e) => e.id === id)?.color ?? '#64748b'; }
  lista(e: Etapa): Lead[] { return this.leads().filter((l) => l.etapa_id === e.id); }
  total(e: Etapa): number { return this.resumen()?.por_etapa[e.id]?.n ?? this.lista(e).length; }
  valor(e: Etapa): number { return this.resumen()?.por_etapa[e.id]?.valor ?? 0; }

  // ---------------- Carga ----------------
  private filtro(estado: string, limite: number, desde = 0) {
    return { estado, q: this.q(), asesor_id: this.fAsesor(), vencidos: this.vencidos(), limite, desde };
  }

  recargar(): void {
    this.desde = 0;
    this.api.resumen().subscribe({ next: (r) => this.resumen.set(r), error: () => undefined });
    this.api.leads(this.filtro('abierto', LIMITE)).subscribe({
      next: (ab) => {
        this.hayMas.set(ab.length === LIMITE);
        this.desde = ab.length;
        // Las columnas de Ganado y Perdido muestran solo lo más reciente
        this.api.leads(this.filtro('ganado', 20)).subscribe({
          next: (g) => this.api.leads(this.filtro('perdido', 20)).subscribe({
            next: (p) => this.leads.set([...ab, ...g, ...p]), error: () => this.leads.set([...ab, ...g]),
          }),
          error: () => this.leads.set(ab),
        });
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  masAbiertos(): void {
    this.api.leads(this.filtro('abierto', LIMITE, this.desde)).subscribe({
      next: (mas) => { this.leads.update((l) => [...l, ...mas]); this.desde += mas.length; this.hayMas.set(mas.length === LIMITE); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  buscar(v: string): void {
    this.q.set(v);
    window.clearTimeout(this.temporizador);
    this.temporizador = window.setTimeout(() => this.recargar(), 350);  // espera a que termines de escribir
  }
  filtrarAsesor(v: string): void { this.fAsesor.set(v === '' ? null : Number(v)); this.recargar(); }
  alternarVencidos(v: boolean): void { this.vencidos.set(v); this.recargar(); }
  abrir(id: number): void { this.abierto.set(id); }

  // ---------------- Arrastrar entre etapas ----------------
  arrastrar(l: Lead): void { this.arrastrado = l; }

  soltar(e: Etapa): void {
    const l = this.arrastrado;
    this.arrastrado = null;
    if (!l || l.etapa_id === e.id) return;
    if (e.tipo === 'perdida') { this.motivo.set(''); this.perdida.set({ lead: l, etapa: e }); return; }
    this.mover(l, e, '');
  }

  private mover(l: Lead, e: Etapa, motivo: string): void {
    const antes = this.leads();
    const estado = e.tipo === 'ganada' ? 'ganado' : e.tipo === 'perdida' ? 'perdido' : 'abierto';
    this.leads.update((ls) => ls.map((x) => (x.id === l.id ? { ...x, etapa_id: e.id, estado } : x)));  // se ve al instante
    this.api.mover(l.id, e.id, motivo).subscribe({
      next: () => this.recargar(),
      error: (er: HttpErrorResponse) => { this.leads.set(antes); this.fallo(er); },
    });
  }

  confirmarPerdida(): void {
    const p = this.perdida();
    if (!p) return;
    this.perdida.set(null);
    this.mover(p.lead, p.etapa, this.motivo().trim());
  }

  // ---------------- Nuevo lead ----------------
abrirNuevo(): void {
  this.nl.set({
    nombre: '',
    empresa_nombre: '',
    telefono: '',
    correo: '',
    interes: '',
    valor_estimado: '0',
    asesor_id: ''
  });

  this.errorModal.set('');
  this.nuevo.set(true);
}

campoNuevo(k: keyof NuevoLeadForm, v: string): void {
  this.nl.update((x) => ({
    ...x,
    [k]: v
  }));
}

crear(): void {
  const n = this.nl();

  const cuerpo: Record<string, unknown> = {
    nombre: n.nombre.trim(),
    empresa_nombre: n.empresa_nombre.trim(),
    telefono: n.telefono.trim(),
    correo: n.correo.trim(),
    interes: n.interes.trim(),
    valor_estimado: Number(n.valor_estimado) || 0,
  };

  if (this.esAdmin() && n.asesor_id) {
    cuerpo['asesor_id'] = Number(n.asesor_id);
  }

  this.api.crear(cuerpo).subscribe({
    next: (r) => {
      this.nuevo.set(false);
      this.ok('Lead creado');
      this.recargar();
      this.abierto.set(r.id);
    },
    error: (e: HttpErrorResponse) => {
      const d = e.error?.detail;
      this.errorModal.set(
        typeof d === 'string'
          ? d
          : 'Revisa los datos: hay campos vacíos o inválidos'
      );
    },
  });
}
  // ---------------- Importar CSV ----------------
  abrirImport(): void { this.csv.set([]); this.resImport.set(null); this.errorModal.set(''); this.importar.set(true); }

  leerArchivo(archivos: FileList | null): void {
    const a = archivos?.[0];
    if (!a) return;
    this.errorModal.set(''); this.resImport.set(null);
    if (a.size > 2_000_000) { this.errorModal.set('El archivo es muy grande (máximo 2 MB)'); return; }
    a.text().then((t) => {
      const filas = leerCsv(t);
      if (!filas.length) { this.csv.set([]); this.errorModal.set('No se encontraron filas. Revisa que la primera fila tenga los títulos (nombre, telefono, correo…).'); return; }
      if (filas.length > 500) { this.csv.set([]); this.errorModal.set(`El archivo tiene ${filas.length} filas. Divídelo en partes de hasta 500.`); return; }
      this.csv.set(filas);
    });
  }

  ejecutarImport(): void {
    this.api.importar(this.csv()).subscribe({
      next: (r) => { this.resImport.set(r); this.csv.set([]); this.recargar(); },
      error: (e: HttpErrorResponse) => { const d = e.error?.detail; this.errorModal.set(typeof d === 'string' ? d : 'No se pudo importar'); },
    });
  }

  // ---------------- Configuración (solo superadmin) ----------------
  irConfig(): void {
    this.vista.set('config');
    this.api.config().subscribe({
      next: (c) => { this.cfg.set(c); this.reparto.set(c.reparto); this.etapasCfg.set(c.etapas.map((e) => ({ ...e }))); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  editarEtapa(i: number, campo: 'nombre' | 'color' | 'activa', valor: string | boolean): void {
    this.etapasCfg.update((l) => l.map((e, j) => (j === i ? { ...e, [campo]: valor } : e)));
  }

  subir(i: number, d: number): void {
    this.etapasCfg.update((l) => { const c = [...l]; const j = i + d; if (j < 0 || j >= c.length) return l; [c[i], c[j]] = [c[j], c[i]]; return c; });
  }

  nuevaEtapa(): void {
    this.etapasCfg.update((l) => {
      const i = l.findIndex((e) => e.tipo !== 'abierta');  // se agrega antes de Ganado / Perdido
      const nueva: Etapa = { id: 0, nombre: 'Nueva etapa', orden: 0, tipo: 'abierta', color: '#64748b', activa: true, leads: 0 };
      return i === -1 ? [...l, nueva] : [...l.slice(0, i), nueva, ...l.slice(i)];
    });
  }

  guardarConfig(): void {
    this.api.guardarConfig({
      reparto: this.reparto(),
      etapas: this.etapasCfg().map((e) => ({ id: e.id || null, nombre: e.nombre.trim(), color: e.color, tipo: e.tipo, activa: e.activa })),
    }).subscribe({
      next: () => { this.ok('Configuración guardada'); this.api.etapas().subscribe({ next: (e) => this.etapas.set(e) }); this.irConfig(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }
}