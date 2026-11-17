import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import { IconComponent } from '../../shared/icon.component';
import { CampoForm, CrmService, DestinoCampo, Ejecutivo, Formulario, TipoCampo } from './crm.service';

interface EdForm {
  id: number | null; slug: string; nombre: string; titulo: string; descripcion: string; boton: string;
  exitoTitulo: string; exitoMensaje: string; origen: string; ejecutivoId: number | null; activo: boolean; campos: CampoForm[];
}

const TIPOS: { id: TipoCampo; label: string }[] = [
  { id: 'texto', label: 'Texto corto' }, { id: 'telefono', label: 'Teléfono' }, { id: 'correo', label: 'Correo' },
  { id: 'numero', label: 'Número' }, { id: 'area', label: 'Texto largo' }, { id: 'lista', label: 'Lista de opciones' },
  { id: 'casilla', label: 'Casilla (sí/no)' },
];
const DESTINOS: Record<DestinoCampo, string> = {
  nombre: 'Nombre del lead', telefono: 'Teléfono del lead', correo: 'Correo del lead', empresa: 'Empresa del lead',
  interes: 'Interés del lead', valor: 'Valor estimado', nota: 'Solo como nota en el historial',
};
const DESTINOS_POR_TIPO: Record<TipoCampo, DestinoCampo[]> = {
  texto: ['nota', 'nombre', 'empresa', 'interes'], telefono: ['telefono', 'nota'], correo: ['correo', 'nota'],
  numero: ['valor', 'nota'], area: ['nota'], lista: ['nota', 'empresa', 'interes'], casilla: ['nota'],
};

function slugificar(t: string): string {
  return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

@Component({
  selector: 'app-crm-formularios',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (mensaje()) { <p class="ok"><app-icon name="circle-check" [size]="18" /> {{ mensaje() }}</p> }
    @if (error()) { <p class="error"><app-icon name="alert" [size]="18" /> {{ error() }}</p> }

    <div class="barra-sup">
      <p class="nota">Cada formulario tiene su propia dirección pública. Compártela en tu web, en anuncios o en redes. Cada envío crea un lead en el CRM. Agrega <b>?origen=tiktok</b> (u otra palabra en minúsculas) al final de la dirección para saber de dónde llegó cada lead.</p>
      <button type="button" class="btn primary" (click)="nuevo()"><app-icon name="plus" [size]="16" /> Nuevo formulario</button>
    </div>

    <div class="lista-f">
      @for (f of lista(); track f.id) {
        <article class="fm" [class.off]="!f.activo">
          <div class="fm-t">
            <h3>{{ f.nombre }}</h3>
            <small class="url">{{ f.url }}</small>
            <div class="tags">
              <span class="tag">{{ f.campos.length }} campos</span>
              <span class="tag">Origen: {{ f.origen }}</span>
              @if (!f.activo) { <span class="tag aviso">Apagado</span> }
            </div>
          </div>
          <div class="fila">
            <button type="button" class="btn" (click)="copiar(f)">Copiar enlace</button>
            <a class="btn" [href]="f.url" target="_blank" rel="noopener">Abrir</a>
            <button type="button" class="btn" (click)="editar(f)"><app-icon name="pencil" [size]="15" /> Editar</button>
          </div>
        </article>
      } @empty {
        <div class="vacio-b"><p>Aún no hay formularios. Crea el primero.</p></div>
      }
    </div>

    @if (ed(); as a) {
      <div class="overlay" (click)="cerrar()">
        <div class="modal ancho" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <header class="m-cab">
            <h3>{{ a.id === null ? 'Nuevo formulario' : 'Editar formulario' }}</h3>
            <button type="button" class="btn ico" aria-label="Cerrar" (click)="cerrar()"><app-icon name="x" [size]="18" /></button>
          </header>

          <div class="grid2">
            <label>Nombre interno <input [value]="a.nombre" (input)="setNombre($any($event.target).value)" /></label>
            <label>Dirección (nombre corto)
              <input [value]="a.slug" [readOnly]="a.id !== null" placeholder="por-ejemplo: plan-coti" (input)="setSlug($any($event.target).value)" />
            </label>
            <label>Título que ve el cliente <input [value]="a.titulo" (input)="setEd({ titulo: $any($event.target).value })" /></label>
            <label>Texto del botón <input maxlength="30" [value]="a.boton" (input)="setEd({ boton: $any($event.target).value })" /></label>
            <label class="ancho2">Descripción debajo del título <input [value]="a.descripcion" (input)="setEd({ descripcion: $any($event.target).value })" /></label>
            <label>Origen del lead (una palabra en minúsculas)
              <input maxlength="20" [value]="a.origen" (input)="setEd({ origen: $any($event.target).value })" />
            </label>
            <label>Se asigna a
              <select (change)="setEd({ ejecutivoId: $any($event.target).value ? +$any($event.target).value : null })">
                <option value="" [selected]="a.ejecutivoId === null">Según el reparto automático</option>
                @for (e of ejecutivos(); track e.id) { <option [value]="e.id" [selected]="a.ejecutivoId === e.id">{{ e.nombre }}</option> }
              </select>
            </label>
            <label>Mensaje de éxito (título) <input [value]="a.exitoTitulo" (input)="setEd({ exitoTitulo: $any($event.target).value })" /></label>
            <label>Mensaje de éxito (texto) <input [value]="a.exitoMensaje" (input)="setEd({ exitoMensaje: $any($event.target).value })" /></label>
            <label class="chk"><input type="checkbox" [checked]="a.activo" (change)="setEd({ activo: $any($event.target).checked })" /> Formulario encendido</label>
          </div>
          @if (a.id !== null) { <p class="nota">Dirección pública: <b>{{ urlActual() }}</b></p> }

          <section class="bloque">
            <div class="fila-sb"><h4>Campos del formulario</h4>
              <button type="button" class="btn" (click)="agregarCampo()"><app-icon name="plus" [size]="15" /> Agregar campo</button>
            </div>
            <p class="nota">Elige qué hace cada campo con el lead. Debe haber un campo de «Nombre del lead» y al menos uno de teléfono o correo.</p>
            <ul class="campos">
              @for (c of a.campos; track c.id; let i = $index) {
                <li class="campo">
                  <div class="c-fila">
                    <input class="c-et" placeholder="Título del campo" [value]="c.etiqueta" (input)="setCampo(i, { etiqueta: $any($event.target).value })" />
                    <select aria-label="Tipo de campo" (change)="cambiarTipo(i, $any($event.target).value)">
                      @for (t of tipos; track t.id) { <option [value]="t.id" [selected]="c.tipo === t.id">{{ t.label }}</option> }
                    </select>
                    <select aria-label="Qué hace con el lead" (change)="setCampo(i, { destino: $any($event.target).value })">
                      @for (d of destinosPara(c.tipo); track d.id) { <option [value]="d.id" [selected]="c.destino === d.id">{{ d.label }}</option> }
                    </select>
                  </div>
                  <div class="c-fila">
                    <label class="chk"><input type="checkbox" [checked]="c.requerido || c.destino === 'nombre'" [disabled]="c.destino === 'nombre'" (change)="setCampo(i, { requerido: $any($event.target).checked })" /> Obligatorio</label>
                    <input class="c-ay" placeholder="Texto de ayuda (opcional)" maxlength="120" [value]="c.ayuda" (input)="setCampo(i, { ayuda: $any($event.target).value })" />
                    <button type="button" class="btn ico" aria-label="Subir" [disabled]="i === 0" (click)="mover(i, -1)"><app-icon name="arrow-up" [size]="14" /></button>
                    <button type="button" class="btn ico" aria-label="Bajar" [disabled]="i === a.campos.length - 1" (click)="mover(i, 1)"><app-icon name="arrow-down" [size]="14" /></button>
                    <button type="button" class="btn ico peligro" aria-label="Quitar campo" (click)="quitarCampo(i)"><app-icon name="trash" [size]="14" /></button>
                  </div>
                  @if (c.tipo === 'lista') {
                    <label>Opciones (una por línea)
                      <textarea rows="3" [value]="opcionesTexto(c)" (input)="setOpciones(i, $any($event.target).value)"></textarea>
                    </label>
                  }
                </li>
              }
            </ul>
          </section>

          <div class="pie">
            @if (a.id !== null) { <button type="button" class="btn peligro" (click)="borrar()"><app-icon name="trash" [size]="15" /> Eliminar</button> }
            <button type="button" class="btn primary" (click)="guardar()">{{ a.id === null ? 'Crear formulario' : 'Guardar cambios' }}</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [ESTILOS_ADMIN, `
    .barra-sup { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; }
    .barra-sup .nota { margin: 0; max-width: 700px; }
    .lista-f { display: flex; flex-direction: column; gap: 12px; }
    .fm { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 16px 18px; background: #fff; border: 1px solid var(--line); border-radius: 16px; }
    .fm.off { opacity: .6; } .fm-t { min-width: 0; display: flex; flex-direction: column; gap: 3px; } .fm-t h3 { margin: 0; }
    .url { color: var(--muted); word-break: break-all; }
    .tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
    .tag { padding: 2px 9px; border-radius: 999px; background: #e8edf8; color: #334155; font-size: .72rem; font-weight: 600; } .tag.aviso { background: #fef3c7; color: #b45309; }
    .vacio-b { display: grid; justify-items: center; padding: 40px 20px; color: var(--muted); background: #fff; border: 1px dashed #c3cde6; border-radius: 16px; } .vacio-b p { margin: 0; }
    .modal.ancho { width: min(860px, 100%); } .m-cab { display: flex; justify-content: space-between; align-items: center; }
    .ancho2 { grid-column: 1 / -1; }
    .bloque { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); } .fila-sb { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .campos { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .campo { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--line); border-radius: 14px; background: #fafbfe; }
    .c-fila { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; } .c-et { flex: 2; min-width: 180px; } .c-ay { flex: 1; min-width: 160px; }
    .c-fila select { flex: 1; min-width: 150px; }
  `],
})
export class CrmFormulariosComponent implements OnInit {
  private readonly api: CrmService = inject(CrmService);
  readonly tipos = TIPOS;

  readonly lista = signal<Formulario[]>([]);
  readonly ejecutivos = signal<Ejecutivo[]>([]);
  readonly ed = signal<EdForm | null>(null);
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');
  private slugTocado = false;

  ngOnInit(): void { this.cargar(); }

  private ok(t: string): void { this.error.set(''); this.mensaje.set(t); }
  private fallo(e: HttpErrorResponse): void { this.mensaje.set(''); this.error.set(this.msg(e)); }
  private falla(t: string): void { this.mensaje.set(''); this.error.set(t); }

  private msg(e: HttpErrorResponse): string {
    const d = e.error?.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return 'Revisa los datos: hay campos vacíos o con formato inválido (el nombre corto solo admite letras minúsculas, números y guiones, mínimo 3).';
    return 'No se pudo conectar con el servidor';
  }

  destinosPara(tipo: TipoCampo): { id: DestinoCampo; label: string }[] {
    return DESTINOS_POR_TIPO[tipo].map((id) => ({ id, label: DESTINOS[id] }));
  }
  opcionesTexto(c: CampoForm): string { return c.opciones.join('\n'); }
  urlActual(): string { const a = this.ed(); return this.lista().find((x) => x.id === a?.id)?.url ?? ''; }

  private desde(f: Formulario): EdForm {
    return {
      id: f.id, slug: f.slug, nombre: f.nombre, titulo: f.titulo, descripcion: f.descripcion, boton: f.boton,
      exitoTitulo: f.exito_titulo, exitoMensaje: f.exito_mensaje, origen: f.origen, ejecutivoId: f.ejecutivo_id,
      activo: f.activo, campos: f.campos.map((c) => ({ ...c, opciones: [...c.opciones] })),
    };
  }

  cargar(abrirId?: number): void {
    this.api.ejecutivos().subscribe({ next: (l) => this.ejecutivos.set(l.filter((e) => e.activo)), error: () => undefined });
    this.api.formularios().subscribe({
      next: (l) => {
        this.lista.set(l);
        if (abrirId !== undefined) {
          const f = l.find((x) => x.id === abrirId);
          if (f) this.ed.set(this.desde(f));
        }
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  nuevo(): void {
    this.slugTocado = false;
    this.ed.set({
      id: null, slug: '', nombre: '', titulo: '', descripcion: '', boton: 'Enviar',
      exitoTitulo: '¡Gracias, te contactaremos pronto!', exitoMensaje: 'Recibimos tus datos. Un ejecutivo de ventas se comunicará contigo.',
      origen: 'web', ejecutivoId: null, activo: true,
      campos: [
        { id: 'nombre', tipo: 'texto', etiqueta: 'Nombre completo', requerido: true, destino: 'nombre', opciones: [], ayuda: '' },
        { id: 'telefono', tipo: 'telefono', etiqueta: 'Teléfono / WhatsApp', requerido: false, destino: 'telefono', opciones: [], ayuda: '' },
        { id: 'correo', tipo: 'correo', etiqueta: 'Correo', requerido: false, destino: 'correo', opciones: [], ayuda: '' },
      ],
    });
  }

  editar(f: Formulario): void { this.cargar(f.id); }
  cerrar(): void { this.ed.set(null); }
  setEd(c: Partial<EdForm>): void { this.ed.update((a) => (a ? { ...a, ...c } : a)); }

  setNombre(v: string): void {
    this.ed.update((a) => (a ? { ...a, nombre: v, slug: a.id === null && !this.slugTocado ? slugificar(v) : a.slug } : a));
  }
  setSlug(v: string): void { this.slugTocado = true; this.setEd({ slug: slugificar(v) }); }

  // ---------------- Campos ----------------
  setCampo(i: number, c: Partial<CampoForm>): void {
    this.ed.update((a) => (a ? { ...a, campos: a.campos.map((x, j) => (j === i ? { ...x, ...c } : x)) } : a));
  }

  setOpciones(i: number, v: string): void { this.setCampo(i, { opciones: v.split('\n') }); }

  cambiarTipo(i: number, tipo: TipoCampo): void {
    const a = this.ed();
    if (!a) return;
    const c = a.campos[i];
    let destino: DestinoCampo = DESTINOS_POR_TIPO[tipo].includes(c.destino) ? c.destino : 'nota';
    if ((tipo === 'telefono' || tipo === 'correo') && !a.campos.some((x, j) => j !== i && x.destino === tipo)) destino = tipo;
    this.setCampo(i, { tipo, destino });
  }

  agregarCampo(): void {
    this.ed.update((a) => {
      if (!a || a.campos.length >= 20) return a;
      const n = Math.max(0, ...a.campos.map((c) => Number(/^campo_(\d+)$/.exec(c.id)?.[1] ?? 0))) + 1;
      return { ...a, campos: [...a.campos, { id: `campo_${n}`, tipo: 'texto', etiqueta: 'Nuevo campo', requerido: false, destino: 'nota', opciones: [], ayuda: '' }] };
    });
  }

  quitarCampo(i: number): void {
    this.ed.update((a) => (a ? { ...a, campos: a.campos.filter((_, j) => j !== i) } : a));
  }

  mover(i: number, d: number): void {
    this.ed.update((a) => {
      if (!a) return a;
      const j = i + d;
      if (j < 0 || j >= a.campos.length) return a;
      const c = [...a.campos];
      [c[i], c[j]] = [c[j], c[i]];
      return { ...a, campos: c };
    });
  }

  // ---------------- Acciones ----------------
  copiar(f: Formulario): void {
    navigator.clipboard.writeText(f.url).then(() => this.ok('Enlace copiado'), () => this.falla('No se pudo copiar. Selecciónalo y cópialo a mano.'));
  }

  guardar(): void {
    const a = this.ed();
    if (!a) return;
    if (a.nombre.trim().length < 2) { this.falla('Escribe el nombre interno del formulario'); return; }
    if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(a.slug)) { this.falla('La dirección debe tener de 3 a 40 caracteres: letras minúsculas, números y guiones'); return; }
    if (!/^[a-z]{3,20}$/.test(a.origen.trim().toLowerCase())) { this.falla('El origen debe ser una sola palabra en minúsculas, de 3 a 20 letras (por ejemplo: web, tiktok)'); return; }
    if (a.campos.some((c) => !c.etiqueta.trim())) { this.falla('Todos los campos necesitan un título'); return; }
    const cuerpo = {
      slug: a.slug, nombre: a.nombre.trim(), titulo: a.titulo.trim(), descripcion: a.descripcion.trim(),
      boton: a.boton.trim() || 'Enviar', exito_titulo: a.exitoTitulo.trim(), exito_mensaje: a.exitoMensaje.trim(),
      origen: a.origen.trim().toLowerCase(), ejecutivo_id: a.ejecutivoId, activo: a.activo,
      campos: a.campos.map((c) => ({
        id: c.id, tipo: c.tipo, etiqueta: c.etiqueta.trim(), requerido: c.destino === 'nombre' ? true : c.requerido,
        destino: c.destino, opciones: c.tipo === 'lista' ? c.opciones.map((o) => o.trim()).filter(Boolean) : [], ayuda: c.ayuda.trim(),
      })),
    };
    if (a.id === null) {
      this.api.crearFormulario(cuerpo).subscribe({
        next: (r) => { this.ok('Formulario creado. Ya puedes copiar su enlace.'); this.cargar(r.id); },
        error: (e: HttpErrorResponse) => this.fallo(e),
      });
    } else {
      this.api.guardarFormulario(a.id, cuerpo).subscribe({
        next: () => { this.ok('Cambios guardados'); this.cargar(a.id ?? undefined); },
        error: (e: HttpErrorResponse) => this.fallo(e),
      });
    }
  }

  borrar(): void {
    const a = this.ed();
    if (!a || a.id === null || !confirm(`¿Eliminar el formulario «${a.nombre}»? Su enlace dejará de funcionar. Los leads ya recibidos no se borran.`)) return;
    this.api.borrarFormulario(a.id).subscribe({
      next: () => { this.cerrar(); this.ok('Formulario eliminado'); this.cargar(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }
}