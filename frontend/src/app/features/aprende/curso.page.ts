import { ChangeDetectionStrategy, Component, DestroyRef, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { TiempoRealService } from '../../core/tiempo-real.service';
import { IconComponent, IconName } from '../../shared/icon.component';
import { TipoLeccion } from './aprende-admin.service';
import { AprendeService, CursoAlumno, LeccionCarga, LeccionResumen, NIVELES, duracionTxt } from './aprende.service';
import { AvanceMedia, LeccionVisorComponent } from './leccion-visor.component';

const MODULO: Record<string, string> = {
  perucompras: 'Perú Compras', menor: 'Contratos Menores', mayor: 'Contratos Mayores',
};

@Component({
  selector: 'app-curso',
  imports: [RouterLink, IconComponent, LeccionVisorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (curso(); as c) {
      <header class="top">
        <a class="volver" [routerLink]="['/', modulo, 'capacitacion']"><app-icon name="arrow-left" [size]="16" /> Capacitación</a>
        <div class="t-tit"><small>{{ moduloNombre }}</small><h1>{{ c.titulo }}</h1></div>
        @if (c.acceso) {
          <div class="prog" [attr.aria-label]="'Progreso ' + pct() + '%'">
            <div class="p-barra"><span [style.width.%]="pct()"></span></div>
            <small>{{ c.hechas }} de {{ c.total }} lecciones · {{ pct() }}%</small>
          </div>
        }
      </header>

      <div class="cuerpo">
        <section class="vista">
          @if (!c.acceso) {
            <div class="bloqueado">
              <span class="b-ico"><app-icon name="lock" [size]="34" /></span>
              <h2>Este curso no está incluido en tu plan</h2>
              <p>Mejora tu plan para desbloquear las {{ c.total }} lecciones y empezar a aprender.</p>
              @if (auth.esTitular()) {
                <a class="btn primary" routerLink="/cuenta">Mejorar mi plan <app-icon name="arrow-up-right" [size]="16" /></a>
              } @else {
                <small>Pide al administrador de tu cuenta que mejore el plan.</small>
              }
            </div>
          } @else {
            @if (error()) { <p class="banner"><app-icon name="alert" [size]="18" /> {{ error() }}</p> }
            <app-leccion-visor [leccion]="leccion()" [inicio]="leccion()?.posicion_seg ?? 0"
                               (progreso)="alProgreso($event)" (terminado)="alTerminar()" />

            @if (actual(); as a) {
              <div class="barra-lec">
                <div class="b-tit">
                  <small>Lección {{ indice() + 1 }} de {{ lista().length }}</small>
                  <h2>{{ a.titulo }}</h2>
                </div>
                <div class="b-acc">
                  <button type="button" class="btn" [disabled]="indice() <= 0" (click)="ir(-1)"><app-icon name="arrow-left" [size]="16" /> Anterior</button>
                  <button type="button" class="btn" [class.hecho]="a.completada" (click)="alternar(a)">
                    <app-icon [name]="a.completada ? 'circle-check' : 'check'" [size]="16" />
                    {{ a.completada ? 'Completada' : 'Marcar como completada' }}
                  </button>
                  <button type="button" class="btn primary" [disabled]="indice() >= lista().length - 1" (click)="ir(1)">Siguiente <app-icon name="right" [size]="16" /></button>
                </div>
              </div>
            }
          }

          <article class="info">
            <h3>Acerca de este curso</h3>
            @if (c.subtitulo) { <p class="sub">{{ c.subtitulo }}</p> }
            <div class="datos">
              <span><app-icon name="video" [size]="15" /> {{ c.total }} lecciones</span>
              <span><app-icon name="clock" [size]="15" /> {{ dur(c.duracion_seg) }}</span>
              <span><app-icon name="layers" [size]="15" /> {{ nivelTxt(c.nivel) }}</span>
              @if (c.instructor) { <span><app-icon name="user" [size]="15" /> {{ c.instructor }}</span> }
            </div>
            @if (c.descripcion) { <p class="desc">{{ c.descripcion }}</p> }
          </article>
        </section>

        <aside class="temario" aria-label="Contenido del curso">
          <h3>Contenido del curso</h3>
          @for (s of c.secciones; track s.id; let si = $index) {
            <div class="sec">
              <button type="button" class="sec-cab" [attr.aria-expanded]="abierta(s.id)" (click)="alternarSeccion(s.id)">
                <span class="s-n">{{ si + 1 }}</span>
                <span class="s-t"><b>{{ s.titulo }}</b><small>{{ hechasDe(s.lecciones) }}/{{ s.lecciones.length }} completadas</small></span>
                <app-icon name="arrow-down" [size]="16" [class.giro]="abierta(s.id)" />
              </button>
              @if (abierta(s.id)) {
                <ul class="lecs">
                  @for (l of s.lecciones; track l.id) {
                    <li>
                      <button type="button" class="lec" [class.act]="l.id === lid()" [disabled]="!c.acceso" (click)="irA(l.id)">
                        <span class="chk" [class.ok]="l.completada">
                          @if (l.completada) { <app-icon name="check" [size]="13" /> }
                        </span>
                        <span class="l-t">
                          <b>{{ l.titulo }}</b>
                          <small><app-icon [name]="icono(l.tipo)" [size]="13" /> {{ dur(l.duracion_seg) }}</small>
                          @if (parcial(l) > 0 && parcial(l) < 100) { <span class="mini"><span [style.width.%]="parcial(l)"></span></span> }
                        </span>
                        @if (!c.acceso) { <app-icon name="lock" [size]="14" /> }
                      </button>
                    </li>
                  }
                </ul>
              }
            </div>
          }
        </aside>
      </div>
    } @else if (error()) {
      <p class="banner centro"><app-icon name="alert" [size]="18" /> {{ error() }}</p>
    } @else {
      <p class="cargando">Cargando curso…</p>
    }
  `,
  styles: [`
    :host { display: block; color: #0f172a; --brand: #1d4ed8; --navy: #0a1a3a; --line: #e2e8f4; --muted: #5a6784; }
    * { box-sizing: border-box; }
    .top { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; padding: 14px 24px; color: #fff; background: var(--navy); border-bottom: 3px solid #c8102e; }
    .volver { display: inline-flex; align-items: center; gap: 8px; color: #c3d0f2; font-size: .86rem; font-weight: 600; text-decoration: none; padding: 8px 12px; border-radius: 10px; } .volver:hover { color: #fff; background: rgb(255 255 255 / .1); }
    .t-tit { flex: 1; min-width: 200px; } .t-tit small { color: #8fb0ff; font-size: .72rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; } .t-tit h1 { margin: 2px 0 0; font-size: 1.1rem; letter-spacing: -.01em; }
    .prog { display: flex; flex-direction: column; gap: 6px; min-width: 220px; } .prog small { color: #c3d0f2; font-size: .78rem; }
    .p-barra { height: 7px; border-radius: 999px; background: rgb(255 255 255 / .18); overflow: hidden; } .p-barra span { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #8fb0ff, #fff); transition: width .6s linear; }
    .cuerpo { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 24px; max-width: 1500px; margin: 0 auto; padding: 24px; align-items: start; }
    .vista { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
    .banner { display: flex; align-items: center; gap: 10px; margin: 0; padding: 12px 16px; border-radius: 12px; color: #b91c1c; background: #fef2f2; font-size: .9rem; } .banner.centro { max-width: 640px; margin: 40px auto; }
    .barra-lec { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
    .b-tit small { color: var(--muted); font-size: .78rem; } .b-tit h2 { margin: 2px 0 0; font-size: 1.3rem; letter-spacing: -.02em; }
    .b-acc { display: flex; gap: 8px; flex-wrap: wrap; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 42px; padding: 0 16px; border: 1px solid var(--line); border-radius: 12px; background: #fff; color: #0f172a; font: inherit; font-size: .86rem; font-weight: 600; text-decoration: none; cursor: pointer; transition: .15s; }
    .btn:hover:not(:disabled) { border-color: #aebde3; } .btn:disabled { opacity: .45; cursor: not-allowed; }
    .btn.primary { color: #fff; border-color: transparent; background: linear-gradient(135deg, #1d4ed8, #2f6bff); box-shadow: 0 10px 22px -12px rgb(29 78 216 / .8); }
    .btn.hecho { color: #047857; background: #ecfdf5; border-color: #a7f3d0; }
    .info { padding: 24px; background: #fff; border: 1px solid var(--line); border-radius: 16px; } .info h3 { margin: 0 0 6px; font-size: 1.05rem; } .info .sub { margin: 0 0 12px; color: var(--muted); }
    .datos { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 14px; color: #334155; font-size: .86rem; } .datos span { display: inline-flex; align-items: center; gap: 8px; }
    .desc { margin: 0; color: #334155; line-height: 1.75; white-space: pre-line; }
    .bloqueado { display: grid; justify-items: center; gap: 10px; padding: 64px 24px; text-align: center; background: #fff; border: 1px dashed #c3cde6; border-radius: 18px; }
    .b-ico { display: grid; place-items: center; width: 74px; height: 74px; border-radius: 50%; color: #c8102e; background: #fde7ea; } .bloqueado h2 { margin: 8px 0 0; font-size: 1.3rem; } .bloqueado p { margin: 0 0 8px; color: var(--muted); } .bloqueado small { color: var(--muted); }
    .temario { position: sticky; top: 72px; max-height: calc(100vh - 96px); overflow-y: auto; padding: 8px; background: #fff; border: 1px solid var(--line); border-radius: 16px; }
    .temario > h3 { margin: 10px 12px 8px; font-size: 1rem; }
    .sec + .sec { border-top: 1px solid #edf1f9; }
    .sec-cab { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px; border: 0; border-radius: 12px; background: none; font: inherit; text-align: left; cursor: pointer; } .sec-cab:hover { background: #f5f7fd; }
    .s-n { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; font-size: .78rem; font-weight: 700; color: #fff; background: var(--navy); flex: none; }
    .s-t { flex: 1; min-width: 0; display: flex; flex-direction: column; } .s-t b { font-size: .9rem; line-height: 1.3; } .s-t small { color: var(--muted); font-size: .74rem; }
    .sec-cab app-icon { color: var(--muted); transition: transform .25s; } .giro { transform: rotate(180deg); }
    .lecs { list-style: none; margin: 0 0 6px; padding: 0; }
    .lec { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 12px; border: 0; border-radius: 10px; background: none; font: inherit; text-align: left; color: inherit; cursor: pointer; }
    .lec:hover:not(:disabled) { background: #f5f7fd; } .lec:disabled { cursor: default; opacity: .65; }
    .lec.act { background: #eaf0ff; box-shadow: inset 3px 0 0 var(--brand); }
    .chk { display: grid; place-items: center; width: 20px; height: 20px; border: 1.5px solid #b5c2e0; border-radius: 50%; flex: none; color: #fff; } .chk.ok { border-color: #059669; background: #059669; }
    .l-t { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; } .l-t b { font-size: .86rem; font-weight: 600; line-height: 1.3; }
    .l-t small { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: .74rem; }
    .mini { display: block; height: 3px; margin-top: 4px; border-radius: 999px; background: #e3e9f6; overflow: hidden; } .mini span { display: block; height: 100%; background: var(--brand); transition: width .6s linear; }
    .cargando { padding: 80px 0; text-align: center; color: var(--muted); }
    @media (max-width: 1000px) { .cuerpo { grid-template-columns: 1fr; padding: 16px; } .temario { position: static; max-height: none; } }
  `],
})
export class CursoPage implements OnInit, OnDestroy {
  private readonly route: ActivatedRoute = inject(ActivatedRoute);
  private readonly router: Router = inject(Router);
  private readonly api: AprendeService = inject(AprendeService);
  private readonly rt: TiempoRealService = inject(TiempoRealService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);
  readonly auth: AuthService = inject(AuthService);

  readonly modulo: string = (this.route.snapshot.data['modulo'] as string | undefined) ?? 'perucompras';
  readonly moduloNombre: string = MODULO[this.modulo] ?? '';
  private readonly cid: number = Number(this.route.snapshot.paramMap.get('curso'));

  readonly curso = signal<CursoAlumno | null>(null);
  readonly leccion = signal<LeccionCarga | null>(null);
  readonly lid = signal<number | null>(null);
  readonly error = signal<string>('');
  readonly cerradas = signal<Set<number>>(new Set<number>());
  /** Segundo actual de la lección que se está reproduciendo (para el porcentaje en vivo). */
  readonly posVivo = signal<number>(0);
  private ultimoEnvio = 0;

  readonly lista = computed<LeccionResumen[]>(() => (this.curso()?.secciones ?? []).flatMap((s) => s.lecciones));
  readonly indice = computed<number>(() => this.lista().findIndex((l) => l.id === this.lid()));
  readonly actual = computed<LeccionResumen | null>(() => this.lista()[this.indice()] ?? null);

  /** Porcentaje por tiempo visto: se mueve mientras se reproduce. */
  readonly pct = computed<number>(() => {
    const c = this.curso();
    if (!c) return 0;
    if (c.duracion_seg <= 0) return c.total ? Math.round((c.hechas / c.total) * 100) : 0;
    const id = this.lid();
    const vivo = this.posVivo();
    const visto = this.lista().reduce((n, l) => {
      if (l.completada) return n + l.duracion_seg;
      const pos = l.id === id ? Math.max(l.posicion_seg, vivo) : l.posicion_seg;
      return n + Math.min(pos, l.duracion_seg);
    }, 0);
    return Math.min(100, Math.round((visto / c.duracion_seg) * 100));
  });

  ngOnInit(): void {
    this.cargarCurso(true);
    // Tiempo real: si el superadmin cambia el curso o tu acceso, se actualiza solo
    this.rt.cambios('cursos', 'acceso').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargarCurso(false));
  }

  ngOnDestroy(): void {
    this.guardarPendiente();
  }

  private cargarCurso(primera: boolean): void {
    this.api.curso(this.cid).subscribe({
      next: (c) => {
        this.curso.set(c);
        this.error.set('');
        if (!primera || !c.acceso) return;
        const pedida = Number(this.route.snapshot.queryParamMap.get('l'));
        const todas = c.secciones.flatMap((s) => s.lecciones);
        const inicial = todas.find((l) => l.id === pedida)?.id ?? c.ultima ?? c.siguiente ?? todas[0]?.id ?? null;
        if (inicial !== null) this.irA(inicial);
      },
      error: (e: HttpErrorResponse) => this.error.set(this.msg(e)),
    });
  }

  dur(seg: number): string { return duracionTxt(seg); }
  nivelTxt(n: string): string { return NIVELES[n] ?? n; }
  icono(t: TipoLeccion): IconName {
    return ({ video: 'video', audio: 'headphones', documento: 'file', imagen: 'image', texto: 'align-left' } as const)[t];
  }
  hechasDe(ls: LeccionResumen[]): number { return ls.filter((l) => l.completada).length; }
  abierta(id: number): boolean { return !this.cerradas().has(id); }

  /** Porcentaje de una lección (en vivo para la que se está viendo). */
  parcial(l: LeccionResumen): number {
    if (l.completada) return 100;
    if (!l.duracion_seg) return 0;
    const pos = l.id === this.lid() ? Math.max(l.posicion_seg, this.posVivo()) : l.posicion_seg;
    return Math.min(99, Math.round((Math.min(pos, l.duracion_seg) / l.duracion_seg) * 100));
  }

  alternarSeccion(id: number): void {
    this.cerradas.update((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  irA(id: number): void {
    this.guardarPendiente();
    this.lid.set(id);
    this.leccion.set(null);
    this.posVivo.set(0);
    this.error.set('');
    this.api.leccion(id).subscribe({
      next: (l) => { if (this.lid() === id) this.leccion.set(l); },
      error: (e: HttpErrorResponse) => this.error.set(this.msg(e)),
    });
    this.router.navigate([], { relativeTo: this.route, queryParams: { l: id }, replaceUrl: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  ir(delta: number): void {
    const l = this.lista()[this.indice() + delta];
    if (l) this.irA(l.id);
  }

  alternar(l: LeccionResumen): void { this.marcar(l.id, !l.completada); }

  /** Al terminar un video o audio, la lección se marca sola como completada. */
  alTerminar(): void {
    const a = this.actual();
    if (a && !a.completada) this.marcar(a.id, true);
  }

  /** Avance de un video o audio: mueve el porcentaje y lo guarda cada 10 segundos. */
  alProgreso(p: AvanceMedia): void {
    const id = this.lid();
    if (id === null) return;
    this.posVivo.set(p.actual);
    const ahora = Date.now();
    if (p.forzar || ahora - this.ultimoEnvio > 10_000) {
      this.ultimoEnvio = ahora;
      this.guardar(id, p.actual, p.total);
    }
  }

  private guardarPendiente(): void {
    const id = this.lid();
    if (id !== null && this.posVivo() > 0) this.guardar(id, this.posVivo(), this.leccion()?.duracion_seg ?? 0);
  }

  private guardar(id: number, actual: number, total: number): void {
    this.api.progreso(id, actual, total).subscribe({
      next: (r) => this.curso.update((c) => c && ({
        ...c, hechas: r.hechas, total: r.total,
        secciones: c.secciones.map((s) => ({
          ...s,
          lecciones: s.lecciones.map((l) => (l.id === id
            ? { ...l, posicion_seg: Math.max(l.posicion_seg, actual), completada: l.completada || r.completada }
            : l)),
        })),
      })),
      error: () => undefined,
    });
  }

  private marcar(id: number, valor: boolean): void {
    this.api.completar(id, valor).subscribe({
      next: (r) => this.curso.update((c) => c && ({
        ...c, hechas: r.hechas, total: r.total,
        secciones: c.secciones.map((s) => ({
          ...s, lecciones: s.lecciones.map((l) => (l.id === id ? { ...l, completada: valor } : l)),
        })),
      })),
      error: (e: HttpErrorResponse) => this.error.set(this.msg(e)),
    });
  }

  private msg(e: HttpErrorResponse): string {
    const d = e.error?.detail;
    return typeof d === 'string' ? d : 'No se pudo conectar con el servidor';
  }
}