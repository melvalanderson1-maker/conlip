import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { TiempoRealService } from '../../core/tiempo-real.service';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import { IconComponent } from '../../shared/icon.component';
import { Actividad, AsesorCrm, CrmService, Etapa, LeadDetalle, TipoActividad } from './crm.service';
import { CrmConversacionComponent } from './crm-conversacion.component';

const ZONA = 'America/Lima';
const ORIGEN: Record<string, string> = {
  manual: 'Carga manual', importado: 'Importación', pedido_whatsapp: 'Pedido por WhatsApp', cotizacion: 'Cotización de servicio',
  whatsapp: 'WhatsApp', facebook: 'Facebook', instagram: 'Instagram', web: 'Web',
};
const TIPOS: { id: Exclude<TipoActividad, 'sistema'>; label: string; icono: string }[] = [
  { id: 'nota', label: 'Nota', icono: 'receipt' }, { id: 'llamada', label: 'Llamada', icono: 'phone' },
  { id: 'whatsapp', label: 'WhatsApp', icono: 'phone' }, { id: 'correo', label: 'Correo', icono: 'mail' },
  { id: 'reunion', label: 'Reunión', icono: 'video' }, { id: 'tarea', label: 'Tarea con fecha', icono: 'calendar' },
];

@Component({
  selector: 'app-crm-lead',
  imports: [IconComponent, CrmConversacionComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="overlay lado" (click)="cerrar.emit()">
      <aside class="panel" role="dialog" aria-modal="true" aria-label="Ficha del lead" (click)="$event.stopPropagation()">
        @if (d(); as l) {
          <header class="p-cab">
            <div>
              <small>{{ origen(l.origen) }} · creado {{ fecha(l.creado_en) }}</small>
              <h3>{{ l.nombre }}</h3>
              @if (l.empresa_nombre) { <small>{{ l.empresa_nombre }}</small> }
              <span class="estado" [class.ok]="l.estado === 'ganado'" [class.bad]="l.estado === 'perdido'">{{ l.estado === 'abierto' ? 'Abierto' : (l.estado === 'ganado' ? 'Ganado' : 'Perdido') }}</span>
            </div>
            <button type="button" class="btn ico" aria-label="Cerrar" (click)="cerrar.emit()"><app-icon name="x" [size]="18" /></button>
          </header>

          <div class="p-cuerpo">
            @if (mensaje()) { <p class="ok">{{ mensaje() }}</p> }
            @if (error()) { <p class="error">{{ error() }}</p> }

            <div class="acciones-rapidas">
              @if (l.telefono) {
                <a class="btn wa" [href]="'https://wa.me/' + l.telefono" target="_blank" rel="noopener"><app-icon name="phone" [size]="15" /> WhatsApp</a>
                <a class="btn" [href]="'tel:+' + l.telefono"><app-icon name="phone" [size]="15" /> Llamar</a>
              }
              @if (l.correo) { <a class="btn" [href]="'mailto:' + l.correo"><app-icon name="mail" [size]="15" /> Correo</a> }
            </div>

            <div class="grid2">
              <label>Etapa
                <select (change)="cambiarEtapa($any($event.target).value)">
                  @for (e of etapas(); track e.id) { <option [value]="e.id" [selected]="e.id === l.etapa_id">{{ e.nombre }}</option> }
                </select>
              </label>
              @if (esAdmin()) {
                <label>Asesor
                  <select (change)="asignar($any($event.target).value)">
                    <option value="" [selected]="l.asesor_id === null">Sin asignar</option>
                    @for (a of asesores(); track a.id) { <option [value]="a.id" [selected]="a.id === l.asesor_id">{{ a.nombre }}</option> }
                  </select>
                </label>
              } @else {
                <div class="dato"><small>Valor estimado</small><b>{{ soles(l.valor_estimado) }}</b></div>
              }
            </div>
            @if (l.estado === 'perdido' && l.motivo_perdida) { <p class="nota">Motivo de pérdida: {{ l.motivo_perdida }}</p> }

            <app-crm-conversacion [leadId]="l.id" />

            <section>
              <div class="fila-sb"><h4>Datos</h4>
                <button type="button" class="btn" (click)="editando.set(!editando())">{{ editando() ? 'Cerrar edición' : 'Editar' }}</button></div>
              @if (!editando()) {
                <dl class="datos">
                  <div><dt>Teléfono</dt><dd>{{ l.telefono ? '+' + l.telefono : '—' }}</dd></div>
                  <div><dt>Correo</dt><dd>{{ l.correo || '—' }}</dd></div>
                  <div><dt>Documento</dt><dd>{{ l.doc_tipo }} {{ l.doc_numero }}@if (!l.doc_tipo) { — }</dd></div>
                  <div><dt>Interés</dt><dd>{{ l.interes || '—' }}</dd></div>
                  <div><dt>Valor estimado</dt><dd>{{ soles(l.valor_estimado) }}</dd></div>
                </dl>
              } @else {
                <div class="grid2">
                  <label>Nombre <input [value]="f().nombre" (input)="campo('nombre', $any($event.target).value)" /></label>
                  <label>Empresa <input [value]="f().empresa_nombre" (input)="campo('empresa_nombre', $any($event.target).value)" /></label>
                  <label>Teléfono <input [value]="f().telefono" (input)="campo('telefono', $any($event.target).value)" /></label>
                  <label>Correo <input type="email" [value]="f().correo" (input)="campo('correo', $any($event.target).value)" /></label>
                  <label>Interés <input [value]="f().interes" (input)="campo('interes', $any($event.target).value)" /></label>
                  <label>Valor estimado (S/) <input type="number" min="0" [value]="f().valor_estimado" (input)="campo('valor_estimado', $any($event.target).value)" /></label>
                </div>
                <div class="fila acciones"><button type="button" class="btn primary" (click)="guardar()">Guardar datos</button></div>
              }
            </section>

            <section>
              <h4>Registrar actividad</h4>
              <div class="tipos">
                @for (t of tipos; track t.id) {
                  <button type="button" class="chip" [class.on]="tipo() === t.id" (click)="tipo.set(t.id)">{{ t.label }}</button>
                }
              </div>
              <textarea rows="2" maxlength="1000" [placeholder]="tipo() === 'tarea' ? 'Qué tienes que hacer (por ejemplo: llamar para cerrar la propuesta)' : 'Qué pasó o qué acordaron'" [value]="texto()" (input)="texto.set($any($event.target).value)"></textarea>
              @if (tipo() === 'tarea') {
                <label>¿Cuándo? <input type="datetime-local" [value]="cuando()" (input)="cuando.set($any($event.target).value)" /></label>
              }
              <div class="fila acciones"><button type="button" class="btn primary" [disabled]="!texto().trim()" (click)="agregar()">Agregar</button></div>
            </section>

            @if (pendientes().length) {
              <section>
                <h4>Tareas pendientes</h4>
                <ul class="lista">
                  @for (a of pendientes(); track a.id) {
                    <li class="act pend" [class.venc]="vencida(a)">
                      <div><b>{{ fechaHora(a.programada_en) }}</b>@if (vencida(a)) { <span class="estado bad">Vencida</span> }<p>{{ a.contenido }}</p></div>
                      <button type="button" class="btn" (click)="completar(a)"><app-icon name="circle-check" [size]="15" /> Hecha</button>
                    </li>
                  }
                </ul>
              </section>
            }

            <section>
              <h4>Historial</h4>
              <ul class="lista">
                @for (a of l.actividades; track a.id) {
                  <li class="act" [class.sis]="a.tipo === 'sistema'">
                    <small>{{ nombreTipo(a.tipo) }} · {{ fechaHora(a.creado_en) }} · {{ a.usuario }}</small>
                    <p>{{ a.contenido }}</p>
                    @if (a.tipo === 'tarea' && a.completada_en) { <small class="hecha">Hecha {{ fechaHora(a.completada_en) }}</small> }
                  </li>
                } @empty { <li class="nota">Todavía no hay actividad.</li> }
              </ul>
            </section>

            @if (esAdmin()) {
              <div class="fila"><button type="button" class="btn peligro" (click)="borrar()"><app-icon name="trash" [size]="15" /> Eliminar lead</button></div>
            }
          </div>
        } @else { <p class="cargando">Cargando…</p> }
      </aside>
    </div>

    @if (perdida(); as e) {
      <div class="overlay" (click)="perdida.set(null)">
        <div class="modal" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <h3>¿Por qué se perdió?</h3>
          <textarea rows="3" maxlength="200" placeholder="Por ejemplo: eligió a la competencia, sin presupuesto, no responde" [value]="motivo()" (input)="motivo.set($any($event.target).value)"></textarea>
          <div class="pie">
            <button type="button" class="btn" (click)="perdida.set(null)">Cancelar</button>
            <button type="button" class="btn peligro" [disabled]="!motivo().trim()" (click)="confirmarPerdida(e)">Marcar como perdido</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [ESTILOS_ADMIN, `
    .overlay.lado { place-items: stretch end; padding: 0; z-index: 80; }
    .panel { width: min(620px, 100%); height: 100vh; overflow-y: auto; display: flex; flex-direction: column; background: #fff; box-shadow: -30px 0 70px -30px rgb(10 26 58 / .55); }
    .p-cab { position: sticky; top: 0; z-index: 2; display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 20px 24px; background: linear-gradient(180deg, #f8faff, #fff); border-bottom: 1px solid var(--line); }
    .p-cab small { color: var(--muted); display: block; } .p-cab h3 { margin: 2px 0 6px; font-size: 1.25rem; }
    .p-cuerpo { display: flex; flex-direction: column; gap: 18px; padding: 20px 24px 60px; } .cargando { padding: 40px; text-align: center; color: var(--muted); }
    .acciones-rapidas { display: flex; gap: 8px; flex-wrap: wrap; } .btn.wa { background: #25d366; color: #fff; border-color: transparent; }
    .fila-sb { display: flex; justify-content: space-between; align-items: center; } h4 { margin: 0 0 8px; }
    .dato { display: flex; flex-direction: column; } .dato small { color: var(--muted); }
    .datos { margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 12px 18px; } .datos dt { color: var(--muted); font-size: .76rem; text-transform: uppercase; letter-spacing: .05em; } .datos dd { margin: 2px 0 0; font-weight: 600; word-break: break-word; }
    .tipos { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
    textarea { width: 100%; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 12px; font: inherit; resize: vertical; }
    .lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .act { padding: 10px 14px; border: 1px solid var(--line); border-radius: 12px; background: #fff; } .act p { margin: 4px 0 0; white-space: pre-wrap; line-height: 1.45; } .act small { color: var(--muted); }
    .act.sis { background: #f8faff; } .act.pend { display: flex; justify-content: space-between; align-items: center; gap: 12px; background: #fffbeb; border-color: #fde68a; } .act.venc { background: #fef2f2; border-color: #fecaca; } .hecha { color: #047857 !important; }
  `],
})
export class CrmLeadComponent implements OnInit {
  private readonly api: CrmService = inject(CrmService);
  private readonly rt: TiempoRealService = inject(TiempoRealService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);
  readonly tipos = TIPOS;

  readonly id = input.required<number>();
  readonly etapas = input<Etapa[]>([]);
  readonly asesores = input<AsesorCrm[]>([]);
  readonly esAdmin = input<boolean>(false);
  readonly cerrar = output<void>();
  readonly cambio = output<void>();

  readonly d = signal<LeadDetalle | null>(null);
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');
  readonly editando = signal<boolean>(false);
  readonly f = signal({ nombre: '', empresa_nombre: '', telefono: '', correo: '', interes: '', valor_estimado: '0' });
  readonly tipo = signal<Exclude<TipoActividad, 'sistema'>>('nota');
  readonly texto = signal<string>('');
  readonly cuando = signal<string>('');
  readonly perdida = signal<Etapa | null>(null);
  readonly motivo = signal<string>('');
  readonly pendientes = computed<Actividad[]>(() =>
    (this.d()?.actividades ?? []).filter((a) => a.tipo === 'tarea' && !a.completada_en).sort((x, y) => (x.programada_en ?? '').localeCompare(y.programada_en ?? '')));

  ngOnInit(): void {
    this.cargar();
    // Tiempo real: si alguien más mueve o asigna este lead, la ficha se actualiza (sin pisar lo que estás editando)
    this.rt.cambios('crm').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargar());
  }

  private cargar(): void {
    this.api.lead(this.id()).subscribe({
      next: (l) => {
        this.d.set(l);
        if (!this.editando()) {
          this.f.set({ nombre: l.nombre, empresa_nombre: l.empresa_nombre, telefono: l.telefono, correo: l.correo, interes: l.interes, valor_estimado: String(l.valor_estimado) });
        }
      },
      error: (e: HttpErrorResponse) => { this.fallo(e); },
    });
  }

  private ok(t: string): void { this.error.set(''); this.mensaje.set(t); this.cambio.emit(); }
  private fallo(e: HttpErrorResponse): void {
    this.mensaje.set('');
    const d = e.error?.detail;
    this.error.set(typeof d === 'string' ? d : 'No se pudo conectar con el servidor');
  }

  origen(o: string): string { return ORIGEN[o] ?? o; }
  nombreTipo(t: string): string { return TIPOS.find((x) => x.id === t)?.label ?? 'Sistema'; }
  soles(n: number): string { return `S/ ${n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
  fecha(iso: string): string { return new Date(iso).toLocaleDateString('es-PE', { timeZone: ZONA, day: '2-digit', month: 'short', year: 'numeric' }); }
  fechaHora(iso: string | null): string {
    return iso ? new Date(iso).toLocaleString('es-PE', { timeZone: ZONA, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  }
  vencida(a: Actividad): boolean { return !!a.programada_en && new Date(a.programada_en).getTime() < Date.now(); }
  campo(k: string, v: string): void { this.f.update((x) => ({ ...x, [k]: v })); }

  guardar(): void {
    const f = this.f();
    this.api.editar(this.id(), {
      nombre: f.nombre.trim(), empresa_nombre: f.empresa_nombre.trim(), telefono: f.telefono.trim(), correo: f.correo.trim(),
      interes: f.interes.trim(), valor_estimado: Number(f.valor_estimado) || 0,
    }).subscribe({
      next: () => { this.editando.set(false); this.ok('Datos guardados'); this.cargar(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  cambiarEtapa(valor: string): void {
    const e = this.etapas().find((x) => x.id === Number(valor));
    if (!e) return;
    if (e.tipo === 'perdida') { this.motivo.set(''); this.perdida.set(e); this.cargar(); return; }
    this.api.mover(this.id(), e.id).subscribe({ next: () => { this.ok('Etapa actualizada'); this.cargar(); }, error: (er: HttpErrorResponse) => { this.fallo(er); this.cargar(); } });
  }

  confirmarPerdida(e: Etapa): void {
    this.api.mover(this.id(), e.id, this.motivo().trim()).subscribe({
      next: () => { this.perdida.set(null); this.ok('Marcado como perdido'); this.cargar(); },
      error: (er: HttpErrorResponse) => this.fallo(er),
    });
  }

  asignar(valor: string): void {
    this.api.asignar(this.id(), valor ? Number(valor) : null).subscribe({
      next: () => { this.ok('Asignación actualizada'); this.cargar(); }, error: (e: HttpErrorResponse) => { this.fallo(e); this.cargar(); },
    });
  }

  agregar(): void {
    const cuerpo: Record<string, unknown> = { tipo: this.tipo(), contenido: this.texto().trim() };
    if (this.tipo() === 'tarea') {
      if (!this.cuando()) { this.mensaje.set(''); this.error.set('Indica cuándo debes hacer la tarea'); return; }
      cuerpo['programada_en'] = new Date(this.cuando()).toISOString();
    }
    this.api.actividad(this.id(), cuerpo).subscribe({
      next: () => { this.texto.set(''); this.cuando.set(''); this.ok('Actividad registrada'); this.cargar(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  completar(a: Actividad): void {
    this.api.completar(a.id).subscribe({ next: () => { this.ok('Tarea marcada como hecha'); this.cargar(); }, error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  borrar(): void {
    const l = this.d();
    if (!l || !confirm(`¿Eliminar el lead «${l.nombre}» y todo su historial? No se puede deshacer.`)) return;
    this.api.borrar(l.id).subscribe({ next: () => { this.cambio.emit(); this.cerrar.emit(); }, error: (e: HttpErrorResponse) => this.fallo(e) });
  }
}