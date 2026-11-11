import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../../core/auth.service';
import { TiempoRealService } from '../../../core/tiempo-real.service';
import {
  Ambito, Asignacion, AsignacionesService, ESTADOS_ASIG, EstadoAsig, LISTA_ESTADOS,
} from './asignaciones.service';

@Component({
  selector: 'app-asignaciones',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <div class="cab">
        <div>
          <h2>Asignaciones</h2>
          <p class="sub">Contrataciones que te asignaron tus compañeros o que tú te asignaste.</p>
        </div>
        <span class="live" [class.on]="rt.conectado()">{{ rt.conectado() ? 'En vivo' : 'Reconectando…' }}</span>
      </div>

      <div class="tabs">
        <button type="button" [class.on]="ambito() === 'mias'" (click)="setAmbito('mias')">Para mí</button>
        <button type="button" [class.on]="ambito() === 'enviadas'" (click)="setAmbito('enviadas')">Las que asigné</button>
        @if (auth.esAdmin()) {
          <button type="button" [class.on]="ambito() === 'todas'" (click)="setAmbito('todas')">Todas</button>
        }
      </div>

      <div class="chips">
        <button type="button" class="chip" [class.on]="filtro() === ''" (click)="setFiltro('')">Todas</button>
        @for (e of estados; track e) {
          <button type="button" class="chip" [class.on]="filtro() === e" (click)="setFiltro(e)">{{ nombreEstado(e) }}</button>
        }
      </div>

      @if (error()) { <p class="error">{{ error() }}</p> }

      <div class="grid">
        @for (a of items(); track a.id) {
          <article class="card" [class.nueva]="esNueva(a)">
            <div class="fila1">
              <span class="codigo">{{ a.codigo }}</span>
              @if (esNueva(a)) { <span class="tag-nueva">Nueva</span> }
              <span class="est e-{{ a.estado }}">{{ nombreEstado(a.estado) }}</span>
            </div>
            <h3>{{ a.descripcion }}</h3>
            <p class="ent">{{ a.entidad }}</p>
            <p class="quien">
              @if (ambito() === 'mias') {
                @if (a.por_id === a.para_id) { Auto-asignada } @else { Asignada por <b>{{ a.por_nombre }}</b> }
              } @else {
                Para <b>{{ a.para_nombre }}</b> · por <b>{{ a.por_id === a.para_id ? 'sí mismo' : a.por_nombre }}</b>
              }
              · {{ hace(a.creado_en) }}
            </p>
            @if (a.nota) { <p class="nota">“{{ a.nota }}”</p> }
            <div class="pie">
              <span class="vence">Vence: {{ fecha(a.fec_fin_cot) }}</span>
                <a class="btn" [routerLink]="['/menor/contrataciones']" [queryParams]="{ abrir: a.id_contrato }" [state]="{ contrato: contratoDe(a) }">Ver contrato</a>
              @if (puedeEditar(a)) {
                <select aria-label="Cambiar estado" (change)="cambiarEstado(a, $any($event.target).value)">
                  @for (e of estados; track e) {
                    <option [value]="e" [selected]="a.estado === e">{{ nombreEstado(e) }}</option>
                  }
                </select>
              }
              @if (puedeQuitar(a)) { <button type="button" class="btn" (click)="quitar(a)">Quitar</button> }
            </div>
          </article>
        } @empty {
          <p class="vacio">{{ cargando() ? 'Cargando…' : 'No hay asignaciones aquí todavía.' }}</p>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; color: #0f172a; --brand: #4f46e5; --line: #e6e8f0; --muted: #64748b; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }
    .cab { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 16px; }
    h2 { margin: 0; } .sub { margin: 4px 0 0; color: var(--muted); font-size: .9rem; }
    .live { padding: 4px 12px; border-radius: 999px; font-size: .75rem; font-weight: 600; background: #fef3c7; color: #b45309; }
    .live.on { background: #d1fae5; color: #047857; }
    .tabs { display: flex; gap: 6px; margin-bottom: 12px; border-bottom: 1px solid var(--line); }
    .tabs button { padding: 10px 16px; border: 0; border-bottom: 2px solid transparent; background: none; font: inherit;
      color: var(--muted); cursor: pointer; }
    .tabs button.on { color: var(--brand); border-bottom-color: var(--brand); font-weight: 600; }
    .chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
    .chip { padding: 6px 14px; border-radius: 999px; border: 1px solid var(--line); background: #fff; color: var(--muted);
      font: inherit; font-size: .85rem; cursor: pointer; }
    .chip.on { background: #0f172a; border-color: #0f172a; color: #fff; }
    .error { padding: 10px 14px; border-radius: 10px; background: #fef2f2; color: #b91c1c; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
    .card { display: flex; flex-direction: column; gap: 8px; padding: 16px; background: #fff; border: 1px solid var(--line);
      border-radius: 14px; box-shadow: 0 1px 2px rgb(15 23 42 / .05); }
    .card.nueva { border-color: #a5b4fc; box-shadow: 0 0 0 3px #eef0ff; }
    .fila1 { display: flex; align-items: center; gap: 8px; }
    .codigo { font-size: .78rem; font-weight: 600; color: var(--muted); margin-right: auto; }
    .tag-nueva { padding: 2px 9px; border-radius: 999px; background: var(--brand); color: #fff; font-size: .7rem; font-weight: 700; }
    .est { padding: 2px 10px; border-radius: 999px; font-size: .72rem; font-weight: 600; }
    .e-pendiente { background: #fef3c7; color: #b45309; } .e-en_curso { background: #dbeafe; color: #1d4ed8; }
    .e-cotizada { background: #d1fae5; color: #047857; } .e-descartada { background: #fee2e2; color: #b91c1c; }
    h3 { margin: 0; font-size: .95rem; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .ent, .quien { margin: 0; font-size: .82rem; color: var(--muted); }
    .quien b { color: #0f172a; }
    .nota { margin: 0; padding: 8px 10px; border-radius: 8px; background: #f8f9fc; font-size: .85rem; font-style: italic; }
    .pie { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: auto; padding-top: 6px; }
    .vence { margin-right: auto; font-size: .78rem; color: var(--muted); }
    .btn, select { height: 34px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--line); background: #fff;
      font: inherit; font-size: .85rem; color: #0f172a; cursor: pointer; display: inline-flex; align-items: center; text-decoration: none; }
    .btn:hover { border-color: #c7cbe0; }
    .vacio { grid-column: 1 / -1; text-align: center; color: var(--muted); padding: 50px 0; }
  `],
})
export class AsignacionesPage implements OnInit {
  private readonly api: AsignacionesService = inject(AsignacionesService);
  readonly auth: AuthService = inject(AuthService);
  readonly rt: TiempoRealService = inject(TiempoRealService);

  readonly estados: EstadoAsig[] = LISTA_ESTADOS;
  readonly ambito = signal<Ambito>('mias');
  readonly filtro = signal<'' | EstadoAsig>('');
  readonly items = signal<Asignacion[]>([]);
  readonly cargando = signal<boolean>(false);
  readonly error = signal<string>('');
  /** Ids que llegaron sin ver: conservan la etiqueta "Nueva" mientras estés en esta pantalla. */
  private readonly nuevas = signal<Set<number>>(new Set<number>());

  constructor() {
    // Tiempo real: cualquier cambio de asignaciones recarga la lista (salvo el aviso de "vistas")
    this.rt.eventos.pipe(takeUntilDestroyed()).subscribe((ev) => {
      if (ev.tipo !== 'vistas') this.cargar();
    });
  }

  ngOnInit(): void { this.cargar(); }

  setAmbito(a: Ambito): void { this.ambito.set(a); this.cargar(); }
  setFiltro(f: '' | EstadoAsig): void { this.filtro.set(f); this.cargar(); }

  cargar(): void {
    this.cargando.set(true);
    this.api.listar(this.ambito(), this.filtro()).subscribe({
      next: (l) => {
        this.items.set(l);
        this.cargando.set(false);
        this.error.set('');
        if (this.ambito() === 'mias') this.marcarVistas(l);
      },
      error: (e: HttpErrorResponse) => {
        this.cargando.set(false);
        this.error.set(typeof e.error?.detail === 'string' ? e.error.detail : 'No se pudo cargar');
      },
    });
  }

  private marcarVistas(l: Asignacion[]): void {
    const sinVer = l.filter((a) => !a.visto_en);
    if (!sinVer.length) return;
    this.nuevas.update((s) => new Set<number>([...s, ...sinVer.map((a) => a.id)]));
    this.api.marcarVistas().subscribe({
      next: () => this.rt.sinVer.set(0),
      error: () => undefined,
    });
  }

esNueva(a: Asignacion): boolean { return this.nuevas().has(a.id); }

  /** Datos del contrato que viajan con la navegación para que el detalle se vea al instante. */
  contratoDe(a: Asignacion): Record<string, unknown> {
    return {
      id_contrato: a.id_contrato, codigo: a.codigo, anio: a.anio, objeto: a.objeto,
      descripcion: a.descripcion, entidad: a.entidad, fec_publica: a.fec_publica,
      fec_ini_cot: a.fec_ini_cot, fec_fin_cot: a.fec_fin_cot, id_estado: a.id_estado,
      estado: a.estado_contrato,
    };
  }
  nombreEstado(e: EstadoAsig): string { return ESTADOS_ASIG[e] ?? e; }

  puedeEditar(a: Asignacion): boolean { return this.auth.esAdmin() || a.para_id === this.auth.usuario()?.id; }
  puedeQuitar(a: Asignacion): boolean {
    const yo = this.auth.usuario()?.id;
    return this.auth.esAdmin() || a.por_id === yo || a.para_id === yo;
  }

  cambiarEstado(a: Asignacion, estado: EstadoAsig): void {
    this.api.cambiarEstado(a.id, estado).subscribe({
      next: () => this.items.update((l) => l.map((x) => (x.id === a.id ? { ...x, estado } : x))),
      error: (e: HttpErrorResponse) => this.error.set(typeof e.error?.detail === 'string' ? e.error.detail : 'No se pudo cambiar'),
    });
  }

  quitar(a: Asignacion): void {
    if (!confirm(`¿Quitar la asignación de ${a.codigo}?`)) return;
    this.api.quitar(a.id).subscribe({
      next: () => this.items.update((l) => l.filter((x) => x.id !== a.id)),
      error: (e: HttpErrorResponse) => this.error.set(typeof e.error?.detail === 'string' ? e.error.detail : 'No se pudo quitar'),
    });
  }

  hace(iso: string): string {
    const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return 'hace un momento';
    const m = Math.floor(s / 60);
    if (m < 60) return `hace ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `hace ${h} h`;
    const d = Math.floor(h / 24);
    return `hace ${d} ${d === 1 ? 'día' : 'días'}`;
  }

  fecha(s: string | null): string {
    if (!s) return '—';
    const d = new Date(s.includes('T') ? s : s.replace(' ', 'T'));
    return isNaN(d.getTime())
      ? s
      : d.toLocaleString('es-PE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
}