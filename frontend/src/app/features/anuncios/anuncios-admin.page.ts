import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { IconComponent, IconName } from '../../shared/icon.component';
import { AprendeAdminService, CursoResumen } from '../aprende/aprende-admin.service';
import { AnuncioAdmin, AnunciosService, ICONO_ANUNCIO, TipoAnuncio, haceTxt } from './anuncios.service';

interface FormAnuncio {
  id: number | null; tipo: TipoAnuncio; titulo: string; mensaje: string; cursoId: string;
  paraClientes: boolean; paraPublico: boolean; vence: string; publicar: boolean;
}

const TIPOS: { id: TipoAnuncio; label: string }[] = [
  { id: 'curso', label: 'Curso nuevo' }, { id: 'novedad', label: 'Novedad' }, { id: 'promocion', label: 'Promoción' },
];

@Component({
  selector: 'app-anuncios-admin',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <header class="cab">
        <div>
          <span class="eyebrow">Comunicación</span>
          <h2>Anuncios</h2>
          <p class="sub">Avisa a tus clientes de un curso nuevo o de una novedad. Les llega al instante a su panel y aparece en la portada.</p>
        </div>
        <button type="button" class="btn primary" (click)="nuevo()"><app-icon name="plus" [size]="16" /> Nuevo anuncio</button>
      </header>

      @if (mensaje()) { <p class="banner ok"><app-icon name="circle-check" [size]="18" /> {{ mensaje() }}</p> }
      @if (error()) { <p class="banner bad"><app-icon name="alert" [size]="18" /> {{ error() }}</p> }

      <div class="lista">
        @for (a of anuncios(); track a.id) {
          <article class="item" [class.off]="!a.activo || a.vencido">
            <span class="ico"><app-icon [name]="icono(a.tipo)" [size]="22" /></span>
            <div class="cont">
              <div class="t">
                <h3>{{ a.titulo }}</h3>
                <span class="estado" [class.on]="a.activo && !a.vencido">{{ estadoTxt(a) }}</span>
              </div>
              @if (a.mensaje) { <p>{{ a.mensaje }}</p> }
              <div class="meta">
                @if (a.curso_titulo) { <span><app-icon name="graduation-cap" [size]="14" /> {{ a.curso_titulo }}</span> }
                @if (a.para_clientes) { <span><app-icon name="users" [size]="14" /> Panel de clientes</span> }
                @if (a.para_publico) { <span><app-icon name="eye" [size]="14" /> Portada pública</span> }
                @if (a.vence_en) { <span><app-icon name="clock" [size]="14" /> Hasta {{ fecha(a.vence_en) }}</span> }
                @if (a.activo) { <span><app-icon name="circle-check" [size]="14" /> Leído por {{ a.lecturas }}</span> }
                @if (a.publicado_en) { <span>{{ hace(a.publicado_en) }}</span> }
              </div>
            </div>
            <div class="acc">
              <button type="button" class="btn" [class.primary]="!a.activo" (click)="alternar(a)">
                <app-icon [name]="a.activo ? 'x' : 'megaphone'" [size]="15" /> {{ a.activo ? 'Despublicar' : 'Publicar' }}
              </button>
              <button type="button" class="btn ico" aria-label="Editar" (click)="editar(a)"><app-icon name="pencil" [size]="15" /></button>
              <button type="button" class="btn ico peligro" aria-label="Eliminar" (click)="borrar(a)"><app-icon name="trash" [size]="15" /></button>
            </div>
          </article>
        } @empty {
          <div class="vacio"><app-icon name="megaphone" [size]="36" /><p>Aún no has creado anuncios.</p></div>
        }
      </div>
    </div>

    @if (form(); as f) {
      <div class="overlay" (click)="cerrar()">
        <form class="modal" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); guardar()">
          <header class="m-cab">
            <h3>{{ f.id === null ? 'Nuevo anuncio' : 'Editar anuncio' }}</h3>
            <button type="button" class="btn ico" aria-label="Cerrar" (click)="cerrar()"><app-icon name="x" [size]="18" /></button>
          </header>

          <div class="fila">
            <label>Tipo
              <select (change)="setF({ tipo: $any($event.target).value })">
                @for (t of tipos; track t.id) { <option [value]="t.id" [selected]="f.tipo === t.id">{{ t.label }}</option> }
              </select>
            </label>
            <label class="crece">Curso relacionado (opcional)
              <select (change)="setF({ cursoId: $any($event.target).value })">
                <option value="" [selected]="f.cursoId === ''">Ninguno</option>
                @for (c of cursos(); track c.id) { <option [value]="'' + c.id" [selected]="f.cursoId === '' + c.id">{{ c.titulo }}</option> }
              </select>
            </label>
          </div>
          @if (cursoEnBorrador()) {
            <p class="aviso"><app-icon name="alert" [size]="16" /> Ese curso aún está en borrador: el anuncio no se mostrará hasta que lo publiques.</p>
          }

          <label>Título
            <input maxlength="120" placeholder="Ej. Nuevo curso: Cómo inscribirte en Perú Compras" [value]="f.titulo" (input)="setF({ titulo: $any($event.target).value })" />
          </label>
          <label>Mensaje
            <textarea rows="3" maxlength="400" placeholder="Una o dos frases que animen a verlo" [value]="f.mensaje" (input)="setF({ mensaje: $any($event.target).value })"></textarea>
            <small>{{ f.mensaje.length }}/400</small>
          </label>

          <div class="fila">
            <label class="chk"><input type="checkbox" [checked]="f.paraClientes" (change)="setF({ paraClientes: $any($event.target).checked })" /> Panel de clientes (campana)</label>
            <label class="chk"><input type="checkbox" [checked]="f.paraPublico" (change)="setF({ paraPublico: $any($event.target).checked })" /> Portada pública (barra superior)</label>
          </div>
          <div class="fila">
            <label>Visible hasta (opcional)
              <input type="date" [value]="f.vence" (input)="setF({ vence: $any($event.target).value })" />
            </label>
            @if (f.id === null) {
              <label class="chk"><input type="checkbox" [checked]="f.publicar" (change)="setF({ publicar: $any($event.target).checked })" /> Publicar ahora</label>
            }
          </div>

          <div class="pie">
            <button type="button" class="btn" (click)="cerrar()">Cancelar</button>
            <button type="submit" class="btn primary">{{ f.id === null ? (f.publicar ? 'Crear y publicar' : 'Guardar borrador') : 'Guardar cambios' }}</button>
          </div>
        </form>
      </div>
    }
  `,
  styles: [`
    :host { display: block; color: #0f172a; --brand: #1d4ed8; --navy: #0a1a3a; --line: #e2e8f4; --muted: #5a6784; }
    * { box-sizing: border-box; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 24px 20px 80px; }
    .cab { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 22px; padding: 26px 30px; color: #fff; border-radius: 20px;
      background: radial-gradient(70% 150% at 0% 0%, #1b3c8c 0%, transparent 60%), radial-gradient(60% 120% at 100% 100%, #5a1030 0%, transparent 65%), var(--navy); }
    .eyebrow { display: block; font-size: .72rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: #8fb0ff; }
    h2 { margin: 6px 0 4px; font-size: 1.6rem; letter-spacing: -.03em; } .sub { margin: 0; max-width: 620px; color: #c3d0f2; font-size: .92rem; line-height: 1.55; }
    .banner { display: flex; align-items: center; gap: 10px; margin: 0 0 14px; padding: 12px 16px; border-radius: 12px; font-size: .9rem; } .banner.ok { background: #d1fae5; color: #047857; } .banner.bad { background: #fef2f2; color: #b91c1c; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 40px; padding: 0 16px; border: 1px solid var(--line); border-radius: 11px; background: #fff; color: #0f172a; font: inherit; font-size: .86rem; font-weight: 600; cursor: pointer; transition: .15s; }
    .btn:hover { border-color: #b5c2e0; } .btn.primary { color: #fff; border-color: transparent; background: linear-gradient(135deg, #1d4ed8, #2f6bff); box-shadow: 0 10px 22px -12px rgb(29 78 216 / .8); }
    .cab .btn.primary { color: var(--navy); background: #fff; box-shadow: none; } .btn.ico { width: 38px; padding: 0; } .btn.peligro { color: #b91c1c; } .btn.peligro:hover { background: #fef2f2; border-color: #fecaca; }
    .lista { display: flex; flex-direction: column; gap: 14px; }
    .item { display: flex; gap: 16px; align-items: flex-start; padding: 18px 20px; background: #fff; border: 1px solid var(--line); border-radius: 16px; transition: .2s; }
    .item:hover { border-color: #c3cde6; box-shadow: 0 18px 36px -28px rgb(10 26 58 / .5); } .item.off { background: #fafbfd; }
    .ico { display: grid; place-items: center; width: 46px; height: 46px; border-radius: 13px; color: var(--brand); background: rgb(29 78 216 / .1); flex: none; }
    .item.off .ico { color: #94a3b8; background: #eef1f6; }
    .cont { flex: 1; min-width: 0; } .t { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; } .t h3 { margin: 0; font-size: 1.02rem; letter-spacing: -.01em; }
    .estado { padding: 2px 10px; border-radius: 999px; font-size: .7rem; font-weight: 700; color: #475569; background: #e2e8f0; } .estado.on { color: #047857; background: #d1fae5; }
    .cont p { margin: 6px 0 0; color: #475569; font-size: .9rem; line-height: 1.55; }
    .meta { display: flex; gap: 8px 16px; flex-wrap: wrap; margin-top: 10px; color: var(--muted); font-size: .78rem; } .meta span { display: inline-flex; align-items: center; gap: 6px; }
    .acc { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .vacio { display: grid; justify-items: center; gap: 8px; padding: 56px 20px; color: var(--muted); background: #fff; border: 1px dashed #c3cde6; border-radius: 16px; } .vacio p { margin: 0; }
    .overlay { position: fixed; inset: 0; z-index: 80; display: grid; place-items: start center; padding: 24px 16px; background: rgb(8 18 44 / .6); overflow-y: auto; }
    .modal { width: min(620px, 100%); display: flex; flex-direction: column; gap: 14px; padding: 22px; background: #fff; border-radius: 18px; box-shadow: 0 40px 90px -30px rgb(0 0 0 / .6); }
    .m-cab { display: flex; justify-content: space-between; align-items: center; } .m-cab h3 { margin: 0; font-size: 1.15rem; }
    .fila { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-end; } .crece { flex: 1; min-width: 220px; }
    label { display: flex; flex-direction: column; gap: 6px; font-size: .82rem; font-weight: 600; color: #334155; } label small { font-weight: 400; color: var(--muted); text-align: right; }
    input:not([type=checkbox]), select, textarea { padding: 9px 12px; border: 1px solid #cbd5e1; border-radius: 10px; font: inherit; font-size: .9rem; background: #fff; color: #0f172a; }
    input:not([type=checkbox]), select { height: 40px; } textarea { resize: vertical; }
    input:focus, select:focus, textarea:focus { outline: 0; border-color: var(--brand); box-shadow: 0 0 0 4px rgb(29 78 216 / .12); }
    .chk { flex-direction: row; align-items: center; gap: 8px; font-weight: 500; } .chk input { width: 17px; height: 17px; accent-color: var(--brand); }
    .aviso { display: flex; align-items: center; gap: 8px; margin: 0; padding: 10px 14px; border-radius: 10px; background: #fef3c7; color: #92400e; font-size: .84rem; }
    .pie { display: flex; justify-content: flex-end; gap: 10px; }
    @media (max-width: 700px) { .item { flex-wrap: wrap; } .acc { width: 100%; justify-content: flex-start; } }
  `],
})
export class AnunciosAdminPage implements OnInit {
  private readonly api: AnunciosService = inject(AnunciosService);
  private readonly cursosApi: AprendeAdminService = inject(AprendeAdminService);
  private readonly route: ActivatedRoute = inject(ActivatedRoute);
  readonly tipos = TIPOS;

  readonly anuncios = signal<AnuncioAdmin[]>([]);
  readonly cursos = signal<CursoResumen[]>([]);
  readonly form = signal<FormAnuncio | null>(null);
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');

  readonly cursoEnBorrador = computed<boolean>(() => {
    const id = Number(this.form()?.cursoId);
    return !!id && this.cursos().find((c) => c.id === id)?.publicado === false;
  });

  ngOnInit(): void {
    this.cargar();
    this.cursosApi.cursos().subscribe({
      next: (l) => {
        this.cursos.set(l);
        const pedido = Number(this.route.snapshot.queryParamMap.get('curso'));
        if (pedido) this.desdeCurso(pedido);  // viene del botón "Anunciar este curso"
      },
      error: () => undefined,
    });
  }

  private ok(t: string): void { this.error.set(''); this.mensaje.set(t); }
  private fallo(e: HttpErrorResponse): void { this.mensaje.set(''); this.error.set(this.msg(e)); }
  icono(t: TipoAnuncio): IconName { return ICONO_ANUNCIO[t]; }
  hace(iso: string | null): string { return haceTxt(iso); }
  fecha(iso: string): string { return new Date(iso).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' }); }
  estadoTxt(a: AnuncioAdmin): string { return a.vencido ? 'Vencido' : a.activo ? 'Publicado' : 'Borrador'; }

  cargar(): void {
    this.api.lista().subscribe({ next: (l) => this.anuncios.set(l), error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  private vacio(): FormAnuncio {
    return { id: null, tipo: 'novedad', titulo: '', mensaje: '', cursoId: '', paraClientes: true, paraPublico: true, vence: '', publicar: true };
  }

  nuevo(): void { this.mensaje.set(''); this.error.set(''); this.form.set(this.vacio()); }

  private desdeCurso(id: number): void {
    const c = this.cursos().find((x) => x.id === id);
    if (!c) return;
    this.form.set({
      ...this.vacio(), tipo: 'curso', cursoId: String(id), titulo: `Nuevo curso: ${c.titulo}`.slice(0, 120),
      mensaje: (c.subtitulo || 'Ya está disponible en Capacitación. ¡Empieza hoy!').slice(0, 400),
    });
  }

  editar(a: AnuncioAdmin): void {
    this.mensaje.set(''); this.error.set('');
    this.form.set({
      id: a.id, tipo: a.tipo, titulo: a.titulo, mensaje: a.mensaje, cursoId: a.curso_id ? String(a.curso_id) : '',
      paraClientes: a.para_clientes, paraPublico: a.para_publico, vence: a.vence_en ? a.vence_en.slice(0, 10) : '', publicar: false,
    });
  }

  cerrar(): void { this.form.set(null); }
  setF(cambio: Partial<FormAnuncio>): void { this.form.update((f) => (f ? { ...f, ...cambio } : f)); }

  guardar(): void {
    const f = this.form();
    if (!f) return;
    if (f.titulo.trim().length < 3) { this.cerrarConError('Escribe un título de al menos 3 letras'); return; }
    if (!f.paraClientes && !f.paraPublico) { this.cerrarConError('Elige dónde se mostrará el anuncio'); return; }
    const vence = f.vence ? new Date(`${f.vence}T23:59:59`).toISOString() : null;
    const cursoId = f.cursoId ? Number(f.cursoId) : null;
    const base = {
      tipo: f.tipo, titulo: f.titulo.trim(), mensaje: f.mensaje.trim(),
      para_clientes: f.paraClientes, para_publico: f.paraPublico,
    };
    const obs = f.id === null
      ? this.api.crear({ ...base, curso_id: cursoId, vence_en: vence, publicar: f.publicar })
      : this.api.editar(f.id, {
          ...base, ...(cursoId ? { curso_id: cursoId } : { sin_curso: true }),
          ...(vence ? { vence_en: vence } : { sin_vencimiento: true }),
        });
    obs.subscribe({
      next: () => { this.cerrar(); this.ok(f.id === null && f.publicar ? 'Anuncio publicado: ya les llegó a tus clientes' : 'Anuncio guardado'); this.cargar(); },
      error: (e: HttpErrorResponse) => { this.cerrar(); this.fallo(e); },
    });
  }

  private cerrarConError(t: string): void { this.mensaje.set(''); this.error.set(t); }

  alternar(a: AnuncioAdmin): void {
    this.api.editar(a.id, { activo: !a.activo }).subscribe({
      next: () => { this.ok(a.activo ? 'Anuncio despublicado' : 'Anuncio publicado: ya les llegó a tus clientes'); this.cargar(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  borrar(a: AnuncioAdmin): void {
    if (!confirm(`¿Eliminar el anuncio "${a.titulo}"?`)) return;
    this.api.borrar(a.id).subscribe({
      next: () => { this.ok('Anuncio eliminado'); this.cargar(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  private msg(e: HttpErrorResponse): string {
    const d = e.error?.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return 'Revisa los datos: el título necesita al menos 3 letras.';
    return 'No se pudo conectar con el servidor';
  }
}