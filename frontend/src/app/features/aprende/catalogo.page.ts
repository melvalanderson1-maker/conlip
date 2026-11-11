import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TiempoRealService } from '../../core/tiempo-real.service';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { IconComponent } from '../../shared/icon.component';
import { AprendeService, CursoLista, NIVELES, duracionTxt, portadaUrl } from './aprende.service';

type Estado = 'todos' | 'progreso' | 'completados' | 'nuevos';
type Situacion = 'bloqueado' | 'completado' | 'progreso' | 'nuevo';

const MODULO: Record<string, string> = {
  perucompras: 'Perú Compras', menor: 'Contratos Menores', mayor: 'Contratos Mayores',
};

@Component({
  selector: 'app-catalogo-cursos',
  imports: [RouterLink, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <header class="hero">
        <div class="h-txt">
          <span class="eyebrow">Capacitación</span>
          <h1>Cursos de {{ nombreModulo }}</h1>
          <p>Aprende paso a paso con videos y material de apoyo. Tu avance se guarda automáticamente.</p>
          <div class="stats">
            <span><app-icon name="book-open" [size]="16" /> {{ habilitados() }} {{ habilitados() === 1 ? 'curso habilitado' : 'cursos habilitados' }}</span>
            <span><app-icon name="circle-check" [size]="16" /> {{ completados() }} completados</span>
          </div>
        </div>
        <label class="buscar">
          <app-icon name="search" [size]="18" />
          <input placeholder="Buscar un curso" aria-label="Buscar un curso" [value]="q()" (input)="q.set($any($event.target).value)" />
        </label>
      </header>

      @if (!cargado()) {
        <div class="grid"><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>
      } @else if (!todos().length) {
        <div class="vacio">
          <app-icon name="graduation-cap" [size]="40" />
          <h3>Aún no hay cursos en este módulo</h3>
          <p>Cuando se publiquen, aparecerán aquí.</p>
        </div>
      } @else {
        @if (continuar().length) {
          <section class="bloque">
            <h2>Continuar aprendiendo</h2>
            <div class="cont">
              @for (c of continuar(); track c.id) {
                <a class="seguir" [routerLink]="['/', modulo, 'capacitacion', c.id]">
                  <div class="mini" [attr.data-m]="c.modulo ?? 'general'">
                    @if (c.portada) { <img [src]="portada(c.id)" alt="" loading="lazy" /> }
                    <span class="mini-play"><app-icon name="play" [size]="30" /></span>
                  </div>
                  <div class="s-info">
                    <b>{{ c.titulo }}</b>
                    <div class="barra"><span [style.width.%]="pct(c)"></span></div>
                    <small>{{ c.hechas }} de {{ c.total }} lecciones · {{ pct(c) }}%</small>
                  </div>
                </a>
              }
            </div>
          </section>
        }

        <section class="bloque">
          <div class="filtros">
            <div class="chips" role="tablist" aria-label="Filtrar por estado">
              @for (f of filtros; track f.id) {
                <button type="button" class="chip" [class.on]="estado() === f.id" (click)="estado.set(f.id)">{{ f.label }}</button>
              }
            </div>
            <select aria-label="Nivel" (change)="nivel.set($any($event.target).value)">
              <option value="" [selected]="nivel() === ''">Todos los niveles</option>
              <option value="basico" [selected]="nivel() === 'basico'">Básico</option>
              <option value="intermedio" [selected]="nivel() === 'intermedio'">Intermedio</option>
              <option value="avanzado" [selected]="nivel() === 'avanzado'">Avanzado</option>
            </select>
          </div>

          <div class="grid">
            @for (c of filtrados(); track c.id) {
              @let s = situacion(c);
              <a class="curso" [class.bloq]="s === 'bloqueado'" [routerLink]="['/', modulo, 'capacitacion', c.id]">
                <div class="thumb" [attr.data-m]="c.modulo ?? 'general'">
                  @if (c.portada) { <img [src]="portada(c.id)" alt="" loading="lazy" /> }
                  <span class="t-ico"><app-icon name="graduation-cap" [size]="34" /></span>
                  @if (s === 'bloqueado') { <span class="candado"><app-icon name="lock" [size]="18" /> No incluido en tu plan</span> }
                  @if (s === 'completado') { <span class="hecho"><app-icon name="check" [size]="14" /> Completado</span> }
                </div>
                <div class="c-body">
                  <span class="nivel">{{ nivelTxt(c.nivel) }}</span>
                  <h3>{{ c.titulo }}</h3>
                  @if (c.subtitulo) { <p>{{ c.subtitulo }}</p> }
                  @if (c.instructor) { <small class="inst">{{ c.instructor }}</small> }
                  <div class="meta">
                    <span><app-icon name="video" [size]="14" /> {{ c.total }} lecciones</span>
                    <span><app-icon name="clock" [size]="14" /> {{ dur(c.duracion_seg) }}</span>
                  </div>
                  @if (s === 'progreso' || s === 'completado') {
                    <div class="barra"><span [style.width.%]="pct(c)"></span></div>
                    <small class="pc">{{ pct(c) }}% completado</small>
                  }
                  <span class="cta" [class.alt]="s === 'bloqueado'">
                    {{ s === 'bloqueado' ? 'Ver temario' : s === 'completado' ? 'Repasar' : s === 'progreso' ? 'Continuar' : 'Comenzar' }}
                    <app-icon name="right" [size]="15" />
                  </span>
                </div>
              </a>
            } @empty {
              <p class="sin">No encontramos cursos con esos filtros.</p>
            }
          </div>

          @if (bloqueados() > 0) {
            <aside class="mejora">
              <span class="m-ico"><app-icon name="lock" [size]="22" /></span>
              <div>
                <b>{{ bloqueados() }} {{ bloqueados() === 1 ? 'curso no está incluido' : 'cursos no están incluidos' }} en tu plan</b>
                <p>Mejora tu plan para desbloquearlos y seguir aprendiendo.</p>
              </div>
              @if (auth.esTitular()) {
                <a class="btn" routerLink="/cuenta">Mejorar mi plan <app-icon name="arrow-up-right" [size]="16" /></a>
              } @else {
                <small>Pide a tu administrador que mejore el plan.</small>
              }
            </aside>
          }
        </section>
      }
    </div>
  `,
  styles: [`
    :host { display: block; color: #0f172a; --brand: #1d4ed8; --navy: #0a1a3a; --line: #e2e8f4; --muted: #5a6784; }
    * { box-sizing: border-box; }
    .wrap { max-width: 1240px; margin: 0 auto; padding: 24px 20px 80px; }
    .hero { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; flex-wrap: wrap; padding: 32px 34px; margin-bottom: 28px; color: #fff; border-radius: 22px;
      background: radial-gradient(70% 140% at 0% 0%, #1b3c8c 0%, transparent 60%), radial-gradient(60% 100% at 100% 100%, #5a1030 0%, transparent 65%), var(--navy); }
    .eyebrow { font-size: .72rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: #8fb0ff; }
    h1 { margin: 8px 0 8px; font-size: clamp(1.6rem, 3vw, 2.2rem); letter-spacing: -.03em; line-height: 1.1; }
    .h-txt p { margin: 0 0 16px; max-width: 520px; color: #c3d0f2; line-height: 1.6; }
    .stats { display: flex; gap: 20px; flex-wrap: wrap; font-size: .85rem; color: #dbe5fb; } .stats span { display: inline-flex; align-items: center; gap: 8px; }
    .buscar { display: flex; align-items: center; gap: 10px; min-width: 280px; height: 48px; padding: 0 16px; color: #8ea3d6; background: rgb(255 255 255 / .1); border: 1px solid rgb(255 255 255 / .2); border-radius: 14px; }
    .buscar:focus-within { background: #fff; color: #0f172a; border-color: #fff; }
    .buscar input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; color: inherit; font: inherit; } .buscar input::placeholder { color: #9db2e6; }
    .bloque { margin-bottom: 34px; } .bloque h2 { margin: 0 0 14px; font-size: 1.2rem; letter-spacing: -.02em; }
    .cont { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
    .seguir { display: flex; gap: 14px; padding: 12px; color: inherit; text-decoration: none; background: #fff; border: 1px solid var(--line); border-radius: 16px; transition: .2s; }
    .seguir:hover { border-color: #aebde3; box-shadow: 0 18px 36px -24px rgb(10 26 58 / .5); }
    .mini { position: relative; display: grid; place-items: center; width: 120px; aspect-ratio: 16 / 10; border-radius: 10px; overflow: hidden; flex: none; color: #fff; background: linear-gradient(135deg, #334155, #64748b); }
    .mini img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; } .mini-play { position: relative; opacity: .95; }
    .s-info { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 8px; } .s-info b { font-size: .92rem; line-height: 1.3; } .s-info small { color: var(--muted); }
    .filtros { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
    .chips { display: flex; gap: 8px; flex-wrap: wrap; }
    .chip { padding: 7px 16px; border: 1px solid var(--line); border-radius: 999px; background: #fff; color: var(--muted); font: inherit; font-size: .85rem; font-weight: 600; cursor: pointer; transition: .15s; }
    .chip:hover { border-color: #aebde3; } .chip.on { color: #fff; background: var(--navy); border-color: var(--navy); }
    select { height: 40px; padding: 0 12px; border: 1px solid var(--line); border-radius: 10px; background: #fff; font: inherit; font-size: .88rem; color: #0f172a; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 20px; }
    .curso { display: flex; flex-direction: column; overflow: hidden; color: inherit; text-decoration: none; background: #fff; border: 1px solid var(--line); border-radius: 18px; transition: transform .25s, box-shadow .25s, border-color .25s; }
    .curso:hover { transform: translateY(-4px); border-color: #aebde3; box-shadow: 0 26px 48px -28px rgb(10 26 58 / .55); }
    .thumb { position: relative; display: grid; place-items: center; aspect-ratio: 16 / 9; color: rgb(255 255 255 / .9); background: linear-gradient(135deg, #334155, #64748b); overflow: hidden; }
    .thumb[data-m='perucompras'], .mini[data-m='perucompras'] { background: linear-gradient(135deg, #0a1a3a, #1d4ed8); }
    .thumb[data-m='menor'], .mini[data-m='menor'] { background: linear-gradient(135deg, #112a5e, #2f6bff); }
    .thumb[data-m='mayor'], .mini[data-m='mayor'] { background: linear-gradient(135deg, #3a0f24, #c8102e); }
    .thumb img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transition: transform .5s; } .curso:hover .thumb img { transform: scale(1.04); }
    .t-ico { position: relative; opacity: .85; }
    .thumb:has(img) .t-ico { display: none; }
    .candado, .hecho { position: absolute; left: 12px; bottom: 12px; display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; font-size: .74rem; font-weight: 700; }
    .candado { color: #fff; background: rgb(10 26 58 / .85); backdrop-filter: blur(6px); } .hecho { color: #047857; background: #d1fae5; }
    .curso.bloq .thumb::after { content: ''; position: absolute; inset: 0; background: rgb(10 26 58 / .35); }
    .candado { z-index: 1; }
    .c-body { display: flex; flex-direction: column; gap: 8px; flex: 1; padding: 18px; }
    .nivel { width: fit-content; padding: 2px 10px; border-radius: 999px; font-size: .7rem; font-weight: 700; color: var(--brand); background: rgb(29 78 216 / .09); }
    .c-body h3 { margin: 0; font-size: 1.02rem; line-height: 1.35; letter-spacing: -.01em; } .c-body p { margin: 0; color: var(--muted); font-size: .86rem; line-height: 1.5; }
    .inst { color: var(--muted); } .meta { display: flex; gap: 16px; margin-top: 2px; color: var(--muted); font-size: .8rem; } .meta span { display: inline-flex; align-items: center; gap: 6px; }
    .barra { height: 6px; border-radius: 999px; background: #e8edf8; overflow: hidden; } .barra span { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #1d4ed8, #2f6bff); }
    .pc { color: var(--muted); }
    .cta { display: inline-flex; align-items: center; gap: 8px; width: fit-content; margin-top: auto; padding-top: 8px; color: var(--brand); font-size: .88rem; font-weight: 700; } .cta.alt { color: var(--muted); }
    .mejora { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-top: 26px; padding: 18px 22px; background: #fff7f8; border: 1px solid #f6ced5; border-radius: 16px; }
    .m-ico { display: grid; place-items: center; width: 46px; height: 46px; border-radius: 13px; color: #c8102e; background: #fde7ea; flex: none; }
    .mejora div { flex: 1; min-width: 220px; } .mejora b { display: block; margin-bottom: 2px; } .mejora p { margin: 0; color: var(--muted); font-size: .88rem; } .mejora small { color: var(--muted); }
    .btn { display: inline-flex; align-items: center; gap: 8px; height: 42px; padding: 0 18px; border-radius: 12px; color: #fff; font-weight: 600; font-size: .88rem; text-decoration: none; background: linear-gradient(135deg, #1d4ed8, #2f6bff); }
    .vacio { display: grid; justify-items: center; gap: 8px; padding: 64px 20px; color: var(--muted); text-align: center; background: #fff; border: 1px dashed #c3cde6; border-radius: 18px; } .vacio h3 { margin: 6px 0 0; color: #0f172a; } .vacio p { margin: 0; }
    .sin { grid-column: 1 / -1; padding: 40px 0; text-align: center; color: var(--muted); }
    .sk { height: 320px; border-radius: 18px; background: linear-gradient(100deg, #eef1f8 30%, #f8f9fd 50%, #eef1f8 70%) 0 0 / 200% 100%; animation: sh 1.4s infinite; } @keyframes sh { to { background-position: -200% 0; } }
    @media (max-width: 640px) { .hero { padding: 24px 20px; } .buscar { min-width: 0; width: 100%; } }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
  `],
})
export class CatalogoCursosPage implements OnInit {
  private readonly route: ActivatedRoute = inject(ActivatedRoute);
  private readonly api: AprendeService = inject(AprendeService);
  readonly auth: AuthService = inject(AuthService);
  private readonly rt: TiempoRealService = inject(TiempoRealService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);

  readonly modulo: string = (this.route.snapshot.data['modulo'] as string | undefined) ?? 'perucompras';
  readonly nombreModulo: string = MODULO[this.modulo] ?? 'tu módulo';
  readonly filtros: { id: Estado; label: string }[] = [
    { id: 'todos', label: 'Todos' }, { id: 'progreso', label: 'En progreso' },
    { id: 'nuevos', label: 'Sin empezar' }, { id: 'completados', label: 'Completados' },
  ];

  readonly todos = signal<CursoLista[]>([]);
  readonly cargado = signal<boolean>(false);
  readonly q = signal<string>('');
  readonly estado = signal<Estado>('todos');
  readonly nivel = signal<string>('');

  readonly habilitados = computed<number>(() => this.todos().filter((c) => c.acceso).length);
  readonly bloqueados = computed<number>(() => this.todos().filter((c) => !c.acceso).length);
  readonly completados = computed<number>(() => this.todos().filter((c) => this.situacion(c) === 'completado').length);

  readonly continuar = computed<CursoLista[]>(() =>
    this.todos().filter((c) => this.situacion(c) === 'progreso')
      .sort((a, b) => (b.ultimo ?? '').localeCompare(a.ultimo ?? '')).slice(0, 3));

  readonly filtrados = computed<CursoLista[]>(() => {
    const q = this.q().trim().toLowerCase();
    return this.todos().filter((c) => {
      if (q && !`${c.titulo} ${c.subtitulo} ${c.instructor}`.toLowerCase().includes(q)) return false;
      if (this.nivel() && c.nivel !== this.nivel()) return false;
      const s = this.situacion(c);
      switch (this.estado()) {
        case 'progreso': return s === 'progreso';
        case 'completados': return s === 'completado';
        case 'nuevos': return s === 'nuevo';
        default: return true;
      }
    });
  });

  ngOnInit(): void {
    this.cargar();
    // Tiempo real: cursos nuevos, cambios de contenido o de tu plan se reflejan solos
    this.rt.cambios('cursos', 'acceso').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargar());
  }

  private cargar(): void {
    this.api.cursos(this.modulo).subscribe({
      next: (l) => { this.todos.set(l); this.cargado.set(true); },
      error: () => this.cargado.set(true),
    });
  }

  portada(id: number): string { return portadaUrl(id); }
  dur(seg: number): string { return duracionTxt(seg); }
  nivelTxt(n: string): string { return NIVELES[n] ?? n; }
  pct(c: CursoLista): number {
    if (c.duracion_seg > 0) return Math.min(100, Math.round((c.visto_seg / c.duracion_seg) * 100));
    return c.total ? Math.round((c.hechas / c.total) * 100) : 0;
  }

  situacion(c: CursoLista): Situacion {
    if (!c.acceso) return 'bloqueado';
    if (c.total > 0 && c.hechas >= c.total) return 'completado';
    if (c.hechas > 0) return 'progreso';
    return 'nuevo';
  }
}