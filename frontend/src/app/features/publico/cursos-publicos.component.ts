import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, effect, inject, input, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { LeccionVisorComponent } from '../aprende/leccion-visor.component';
import { LeccionCarga, NIVELES, duracionTxt, portadaUrl } from '../aprende/aprende.service';
import { IconComponent, IconName } from '../../shared/icon.component';
import { CursoPublico, CursosPublicosService, LeccionPublica } from './cursos-publicos.service';

@Component({
  selector: 'app-cursos-publicos',
  imports: [RouterLink, IconComponent, LeccionVisorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'cerrar()' },
  template: `
    @if (lista().length) {
      <section class="bloque" [class.seccion]="modo() === 'seccion'">
        <div class="cab">
          <span class="eyebrow">Capacitación</span>
          <h3>{{ titulo() }}</h3>
          <p>Cursos prácticos en video. Mira la primera lección gratis antes de decidir.</p>
        </div>

        <div class="grid">
          @for (c of lista(); track c.id) {
            <article class="curso" tabindex="0" role="button" [attr.aria-label]="'Ver el curso ' + c.titulo" (click)="abrir(c)" (keyup.enter)="abrir(c)">
              <div class="thumb" [attr.data-m]="c.modulo ?? 'general'">
                @if (c.portada) { <img [src]="portada(c.id)" alt="" loading="lazy" /> } @else { <span class="t-ico"><app-icon name="graduation-cap" [size]="34" /></span> }
                <span class="play"><app-icon name="play" [size]="40" /></span>
              </div>
              <div class="c-body">
                <div class="c-meta">
                  <span class="nivel">{{ nivelTxt(c.nivel) }}</span>
                  @if (c.destacado) { <span class="dest">Destacado</span> }
                </div>
                <h4>{{ c.titulo }}</h4>
                @if (c.subtitulo) { <p>{{ c.subtitulo }}</p> }
                @if (c.instructor) { <small class="inst">{{ c.instructor }}</small> }
                <div class="pie">
                  <span><app-icon name="video" [size]="14" /> {{ c.n_lecciones }} lecciones</span>
                  <span><app-icon name="clock" [size]="14" /> {{ dur(c.duracion_seg) }}</span>
                </div>
              </div>
            </article>
          }
        </div>
      </section>
    }

    @if (sel(); as c) {
      <div class="overlay" (click)="cerrar()">
        <div class="modal" role="dialog" aria-modal="true" [attr.aria-label]="c.titulo" (click)="$event.stopPropagation()">
          <button type="button" class="cerrar" aria-label="Cerrar" (click)="cerrar()"><app-icon name="x" [size]="20" /></button>
          <div class="m-grid">
            <div class="m-izq">
              <div class="escena">
                @if (previa(); as p) {
                  <app-leccion-visor [leccion]="p" />
                } @else {
                  <div class="ph" [attr.data-m]="c.modulo ?? 'general'">
                    <app-icon [name]="cargandoPrevia() ? 'play' : 'lock'" [size]="42" />
                    <p>{{ cargandoPrevia() ? 'Cargando vista previa…' : (errorPrevia() || 'Este curso no tiene vista previa gratuita') }}</p>
                  </div>
                }
              </div>

              <h3>{{ c.titulo }}</h3>
              @if (c.subtitulo) { <p class="sub">{{ c.subtitulo }}</p> }
              <div class="datos">
                <span><app-icon name="video" [size]="15" /> {{ c.n_lecciones }} lecciones</span>
                <span><app-icon name="clock" [size]="15" /> {{ dur(c.duracion_seg) }}</span>
                <span><app-icon name="layers" [size]="15" /> {{ nivelTxt(c.nivel) }}</span>
                @if (c.instructor) { <span><app-icon name="user" [size]="15" /> {{ c.instructor }}</span> }
              </div>
              @if (c.descripcion) { <p class="desc">{{ c.descripcion }}</p> }

              <h4 class="t-cont">Contenido del curso</h4>
              @for (s of c.secciones; track $index; let si = $index) {
                <div class="sec">
                  <button type="button" class="sec-cab" [attr.aria-expanded]="abierta(si)" (click)="alternar(si)">
                    <span class="s-t"><b>{{ s.titulo }}</b><small>{{ s.lecciones.length }} {{ s.lecciones.length === 1 ? 'lección' : 'lecciones' }}</small></span>
                    <app-icon name="arrow-down" [size]="16" [class.giro]="abierta(si)" />
                  </button>
                  @if (abierta(si)) {
                    <ul>
                      @for (l of s.lecciones; track l.id) {
                        <li>
                          @if (l.vista_previa) {
                            <button type="button" class="lec libre" [class.act]="previaId() === l.id" (click)="verPrevia(l)">
                              <app-icon name="play" [size]="16" />
                              <span class="l-t">{{ l.titulo }}</span>
                              <span class="pill">Vista previa</span>
                              <small>{{ dur(l.duracion_seg) }}</small>
                            </button>
                          } @else {
                            <div class="lec bloq">
                              <app-icon name="lock" [size]="16" />
                              <span class="l-t">{{ l.titulo }}</span>
                              <small>{{ dur(l.duracion_seg) }}</small>
                            </div>
                          }
                        </li>
                      }
                    </ul>
                  }
                </div>
              }
            </div>

            <aside class="m-der">
              <div class="acceso">
                <span class="a-ico"><app-icon name="shield-check" [size]="24" /></span>
                <h4>Desbloquea todas las lecciones</h4>
                <p>Contrata un plan que incluya este curso y accede a todo el contenido, con tu progreso guardado.</p>
                <div class="incluido">
                  <small>Incluido en</small>
                  <div class="chips">
                    @for (p of c.planes; track p) { <span class="chip">{{ p }}</span> }
                    @empty { <span class="chip">Todos los planes del paquete</span> }
                  </div>
                </div>
                <button type="button" class="btn primary" (click)="verPlanes()">Ver planes <app-icon name="right" [size]="16" /></button>
                <a class="btn" routerLink="/login">Ya tengo cuenta</a>
                <ul class="beneficios">
                  <li><app-icon name="check" [size]="15" /> Acceso inmediato tras el pago</li>
                  <li><app-icon name="check" [size]="15" /> Avanza a tu ritmo, desde cualquier dispositivo</li>
                  <li><app-icon name="check" [size]="15" /> Tu progreso se guarda automáticamente</li>
                </ul>
              </div>
            </aside>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block; --navy: #0a1a3a; --blue: #1d4ed8; --red: #c8102e; --line: #dfe5f1; --muted: #5a6784; --ink: #0f1c3a; color: var(--ink); }
    * { box-sizing: border-box; }
    .bloque { margin-top: 30px; } .bloque.seccion { max-width: 1180px; margin: 0 auto; padding: 84px 20px 20px; }
    .cab { margin-bottom: 22px; } .eyebrow { display: inline-flex; align-items: center; gap: 10px; font-size: .72rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--blue); }
    .eyebrow::before { content: ''; width: 24px; height: 3px; border-radius: 2px; background: var(--red); }
    .cab h3 { margin: 10px 0 6px; font-size: 1.5rem; font-weight: 800; letter-spacing: -.025em; } .cab p { margin: 0; color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 20px; }
    .curso { display: flex; flex-direction: column; overflow: hidden; background: #fff; border: 1.5px solid var(--line); border-radius: 18px; cursor: pointer; transition: transform .25s, box-shadow .25s, border-color .25s; }
    .curso:hover, .curso:focus-visible { transform: translateY(-4px); border-color: rgb(29 78 216 / .5); box-shadow: 0 26px 48px -28px rgb(10 26 58 / .55); outline: 0; }
    .thumb { position: relative; display: grid; place-items: center; aspect-ratio: 16 / 9; color: rgb(255 255 255 / .9); background: linear-gradient(135deg, #334155, #64748b); overflow: hidden; }
    .thumb[data-m='perucompras'], .ph[data-m='perucompras'] { background: linear-gradient(135deg, #0a1a3a, #1d4ed8); }
    .thumb[data-m='menor'], .ph[data-m='menor'] { background: linear-gradient(135deg, #112a5e, #2f6bff); }
    .thumb[data-m='mayor'], .ph[data-m='mayor'] { background: linear-gradient(135deg, #3a0f24, #c8102e); }
    .thumb img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transition: transform .5s; } .curso:hover .thumb img { transform: scale(1.05); }
    .play { position: absolute; display: grid; place-items: center; width: 64px; height: 64px; border-radius: 50%; color: #fff; background: rgb(10 26 58 / .55); backdrop-filter: blur(4px); opacity: 0; transform: scale(.8); transition: .3s; }
    .curso:hover .play, .curso:focus-visible .play { opacity: 1; transform: none; }
    .c-body { display: flex; flex-direction: column; gap: 8px; flex: 1; padding: 18px; }
    .c-meta { display: flex; gap: 8px; align-items: center; } .nivel { padding: 2px 10px; border-radius: 999px; font-size: .7rem; font-weight: 700; color: var(--blue); background: rgb(29 78 216 / .09); }
    .dest { padding: 2px 10px; border-radius: 999px; font-size: .7rem; font-weight: 700; color: #fff; background: var(--red); }
    .c-body h4 { margin: 0; font-size: 1.02rem; line-height: 1.35; letter-spacing: -.01em; } .c-body p { margin: 0; color: var(--muted); font-size: .86rem; line-height: 1.5; } .inst { color: var(--muted); }
    .pie { display: flex; gap: 16px; margin-top: auto; padding-top: 10px; border-top: 1px solid #edf1f9; color: var(--muted); font-size: .8rem; } .pie span { display: inline-flex; align-items: center; gap: 6px; }

    .overlay { position: fixed; inset: 0; z-index: 90; display: grid; place-items: start center; padding: 24px 16px; background: rgb(8 18 44 / .72); backdrop-filter: blur(3px); overflow-y: auto; animation: f .2s; }
    @keyframes f { from { opacity: 0; } } @keyframes pop { from { opacity: 0; transform: translateY(18px) scale(.98); } }
    .modal { position: relative; width: min(1120px, 100%); background: #fff; border-radius: 22px; box-shadow: 0 40px 100px -30px rgb(0 0 0 / .7); animation: pop .3s cubic-bezier(.2, .8, .2, 1); }
    .cerrar { position: absolute; top: 14px; right: 14px; z-index: 2; display: grid; place-items: center; width: 38px; height: 38px; border: 0; border-radius: 50%; color: #fff; background: rgb(10 26 58 / .75); cursor: pointer; } .cerrar:hover { background: var(--navy); }
    .m-grid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 28px; padding: 24px; align-items: start; }
    .m-izq { min-width: 0; } .escena { margin-bottom: 18px; }
    .ph { display: grid; place-content: center; justify-items: center; gap: 10px; aspect-ratio: 16 / 9; border-radius: 14px; color: rgb(255 255 255 / .9); text-align: center; padding: 20px; } .ph p { margin: 0; font-size: .92rem; }
    .m-izq h3 { margin: 0 0 4px; font-size: 1.5rem; letter-spacing: -.025em; } .sub { margin: 0 0 12px; color: var(--muted); }
    .datos { display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 14px; color: #334155; font-size: .85rem; } .datos span { display: inline-flex; align-items: center; gap: 8px; }
    .desc { margin: 0 0 8px; color: #334155; line-height: 1.75; white-space: pre-line; }
    .t-cont { margin: 22px 0 10px; font-size: 1.05rem; }
    .sec { border: 1px solid var(--line); border-radius: 14px; overflow: hidden; } .sec + .sec { margin-top: 8px; }
    .sec-cab { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 14px 16px; border: 0; background: #f6f8fd; font: inherit; text-align: left; cursor: pointer; }
    .s-t { display: flex; flex-direction: column; } .s-t b { font-size: .92rem; } .s-t small { color: var(--muted); font-size: .76rem; }
    .sec-cab app-icon { color: var(--muted); transition: transform .25s; } .giro { transform: rotate(180deg); }
    .sec ul { list-style: none; margin: 0; padding: 4px 6px 8px; }
    .lec { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 12px; border: 0; border-radius: 10px; background: none; font: inherit; font-size: .88rem; text-align: left; color: inherit; }
    .lec .l-t { flex: 1; min-width: 0; } .lec small { color: var(--muted); font-size: .76rem; }
    .lec.libre { cursor: pointer; color: var(--blue); font-weight: 600; } .lec.libre:hover { background: #f1f5ff; } .lec.libre.act { background: #e6eeff; }
    .lec.bloq { color: #7a869f; } .pill { padding: 2px 10px; border-radius: 999px; font-size: .68rem; font-weight: 700; color: #047857; background: #d1fae5; }
    .m-der { position: sticky; top: 16px; }
    .acceso { display: flex; flex-direction: column; gap: 12px; padding: 22px; background: linear-gradient(170deg, var(--navy), #112a5e); color: #fff; border-radius: 18px; }
    .a-ico { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 14px; background: rgb(255 255 255 / .12); color: #8fb0ff; }
    .acceso h4 { margin: 4px 0 0; font-size: 1.15rem; letter-spacing: -.02em; } .acceso p { margin: 0; color: #c3d0f2; font-size: .88rem; line-height: 1.6; }
    .incluido small { display: block; margin-bottom: 8px; color: #8fb0ff; font-size: .72rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; } .chip { padding: 4px 11px; border-radius: 8px; font-size: .74rem; font-weight: 600; background: rgb(255 255 255 / .12); color: #e6ecff; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 46px; border-radius: 12px; border: 1.5px solid rgb(255 255 255 / .3); background: transparent; color: #fff; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; transition: .2s; }
    .btn:hover { background: rgb(255 255 255 / .1); } .btn.primary { color: var(--navy); background: #fff; border-color: transparent; box-shadow: 0 12px 26px -12px rgb(0 0 0 / .6); } .btn.primary:hover { background: #eef3ff; }
    .beneficios { list-style: none; display: flex; flex-direction: column; gap: 8px; margin: 4px 0 0; padding: 14px 0 0; border-top: 1px solid rgb(255 255 255 / .15); font-size: .82rem; color: #dbe5fb; }
    .beneficios li { display: flex; align-items: center; gap: 8px; } .beneficios app-icon { color: #8fb0ff; }
    @media (max-width: 900px) { .m-grid { grid-template-columns: 1fr; padding: 16px; } .m-der { position: static; order: -1; } .overlay { padding: 8px; } .bloque.seccion { padding-top: 64px; } }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
  `],
})
export class CursosPublicosComponent implements OnInit {
  private readonly svc: CursosPublicosService = inject(CursosPublicosService);

  /** 'todos' | 'general' | id de módulo (menor, mayor, perucompras) */
  readonly filtro = input<string>('todos');
  readonly modo = input<'incrustado' | 'seccion'>('incrustado');
  readonly titulo = input<string>('Cursos incluidos');

  readonly sel = signal<CursoPublico | null>(null);
  readonly previa = signal<LeccionCarga | null>(null);
  readonly previaId = signal<number | null>(null);
  readonly cargandoPrevia = signal<boolean>(false);
  readonly errorPrevia = signal<string>('');
  readonly cerradas = signal<Set<number>>(new Set<number>());

  readonly lista = computed<CursoPublico[]>(() => {
    const f = this.filtro();
    const todos = this.svc.cursos();
    if (f === 'todos') return todos;
    if (f === 'general') return todos.filter((c) => !c.modulo);
    return todos.filter((c) => c.modulo === f);
  });

  constructor() {
    effect(() => { document.body.style.overflow = this.sel() ? 'hidden' : ''; });
    inject(DestroyRef).onDestroy(() => { document.body.style.overflow = ''; });
  }

  ngOnInit(): void { this.svc.cargar(); }

  portada(id: number): string { return portadaUrl(id); }
  dur(seg: number): string { return duracionTxt(seg); }
  nivelTxt(n: string): string { return NIVELES[n] ?? n; }
  abierta(i: number): boolean { return !this.cerradas().has(i); }

  alternar(i: number): void {
    this.cerradas.update((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  }

  abrir(c: CursoPublico): void {
    this.sel.set(c);
    this.cerradas.set(new Set<number>());
    this.previa.set(null);
    this.previaId.set(null);
    this.errorPrevia.set('');
    const primera = c.secciones.flatMap((s) => s.lecciones).find((l) => l.vista_previa);
    if (primera) this.verPrevia(primera);
  }

  verPrevia(l: LeccionPublica): void {
    this.previaId.set(l.id);
    this.previa.set(null);
    this.errorPrevia.set('');
    this.cargandoPrevia.set(true);
    this.svc.vistaPrevia(l.id).subscribe({
      next: (p) => { if (this.previaId() === l.id) { this.previa.set(p); this.cargandoPrevia.set(false); } },
      error: (e: HttpErrorResponse) => {
        this.cargandoPrevia.set(false);
        this.errorPrevia.set(typeof e.error?.detail === 'string' ? e.error.detail : 'No se pudo cargar la vista previa');
      },
    });
  }

  cerrar(): void { if (this.sel()) { this.sel.set(null); this.previa.set(null); } }

  verPlanes(): void {
    this.cerrar();
    setTimeout(() => document.getElementById('planes')?.scrollIntoView({ behavior: 'smooth' }), 60);
  }
}