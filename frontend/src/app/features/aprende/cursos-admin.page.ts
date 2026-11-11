import { NgTemplateOutlet } from '@angular/common';
import { HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { API } from '../../core/api';
import { IconComponent, IconName } from '../../shared/icon.component';
import { CatalogoService } from '../plataforma/catalogo.service';
import { AprendeService, LeccionCarga } from './aprende.service';
import { LeccionVisorComponent } from './leccion-visor.component';
import { duracionDeArchivo, duracionDeUrl, duracionVimeo, duracionYoutube, idYoutube } from './duracion-media';
import {
  ArchivoSubido, AprendeAdminService, CursoDetalle, CursoResumen, LeccionAdmin, LeccionBody,
  ModuloCurso, SeccionAdmin, TipoLeccion,
} from './aprende-admin.service';

type Vista = 'lista' | 'editor';
interface Ajustes {
  titulo: string; subtitulo: string; descripcion: string; instructor: string; nivel: string; modulo: string;
  publicado: boolean; publico: boolean; destacado: boolean; planIds: number[];
}
interface FormLeccion {
  seccionId: number; id: number | null; titulo: string; tipo: TipoLeccion; modo: 'archivo' | 'enlace';
  archivoId: number | null; archivoNombre: string; url: string; contenido: string; minutos: string;
  vistaPrevia: boolean; segundos: number | null;
}

const MODULOS: { id: ModuloCurso; label: string }[] = [
  { id: 'perucompras', label: 'Perú Compras' },
  { id: 'menor', label: 'Contratos Menores' },
  { id: 'mayor', label: 'Contratos Mayores' },
];
const TIPOS: { id: TipoLeccion; label: string }[] = [
  { id: 'video', label: 'Video' }, { id: 'documento', label: 'Documento PDF' }, { id: 'audio', label: 'Audio' },
  { id: 'imagen', label: 'Imagen' }, { id: 'texto', label: 'Lectura (texto)' },
];
const ACEPTA: Record<TipoLeccion, string> = {
  video: '.mp4,.webm', audio: '.mp3,.m4a,.ogg,.wav', documento: '.pdf', imagen: '.png,.jpg,.jpeg,.webp', texto: '',
};

@Component({
  selector: 'app-cursos-admin',
  imports: [IconComponent, NgTemplateOutlet, RouterLink, LeccionVisorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      @if (mensaje()) { <p class="banner ok"><app-icon name="circle-check" [size]="18" /> {{ mensaje() }}</p> }
      @if (error()) { <p class="banner bad"><app-icon name="alert" [size]="18" /> {{ error() }}</p> }

      <!-- ===================== LISTA ===================== -->
      @if (vista() === 'lista') {
        <header class="cab">
          <div>
            <span class="eyebrow">Capacitación</span>
            <h1>Cursos</h1>
            <p class="sub">Arma los cursos que verán tus clientes dentro de cada módulo.</p>
          </div>
        </header>

        <section class="nuevo">
          <app-icon name="plus" [size]="18" />
          <input placeholder="Título del nuevo curso" [value]="ncTitulo()" (input)="ncTitulo.set($any($event.target).value)"
                 (keyup.enter)="crearCurso()" aria-label="Título del nuevo curso" />
          <select aria-label="Módulo" (change)="ncModulo.set($any($event.target).value)">
            <option value="" [selected]="ncModulo() === ''">General (todos los módulos)</option>
            @for (m of modulos; track m.id) { <option [value]="m.id" [selected]="ncModulo() === m.id">{{ m.label }}</option> }
          </select>
          <button type="button" class="btn primary" (click)="crearCurso()">Crear curso</button>
        </section>

        <div class="grid">
          @for (c of cursos(); track c.id; let i = $index) {
            <article class="tarjeta">
              <div class="thumb" [attr.data-m]="c.modulo ?? 'general'">
                @if (c.portada_id && c.publicado) { <img [src]="portadaUrl(c.id)" alt="" (error)="ocultar($event)" /> }
                <span class="t-ico"><app-icon name="graduation-cap" [size]="30" /></span>
                <span class="estado" [class.on]="c.publicado">{{ c.publicado ? 'Publicado' : 'Borrador' }}</span>
              </div>
              <div class="t-body">
                <span class="mod">{{ moduloNombre(c.modulo) }}</span>
                <h3>{{ c.titulo }}</h3>
                <small>{{ c.n_secciones }} secciones · {{ c.n_lecciones }} lecciones · {{ duracion(c.duracion_seg) }}</small>
                <div class="t-acc">
                  <button type="button" class="btn primary" (click)="abrir(c.id)"><app-icon name="pencil" [size]="15" /> Editar</button>
                  <button type="button" class="btn ico" aria-label="Subir" [disabled]="i === 0" (click)="moverCurso(i, -1)"><app-icon name="arrow-up" [size]="15" /></button>
                  <button type="button" class="btn ico" aria-label="Bajar" [disabled]="i === cursos().length - 1" (click)="moverCurso(i, 1)"><app-icon name="arrow-down" [size]="15" /></button>
                </div>
              </div>
            </article>
          } @empty {
            <p class="vacio">Aún no hay cursos. Crea el primero arriba.</p>
          }
        </div>
      }

      <!-- ===================== EDITOR ===================== -->
      @if (vista() === 'editor') {
        @if (curso(); as c) {
          <header class="barra-ed">
            <button type="button" class="btn" (click)="volver()"><app-icon name="arrow-left" [size]="16" /> Cursos</button>
            <div class="b-tit">
              <h1>{{ c.titulo }}</h1>
              <span class="estado" [class.on]="c.publicado">{{ c.publicado ? 'Publicado' : 'Borrador' }}</span>
            </div>
            <a class="btn" [routerLink]="vistaPrevia(c)" target="_blank"><app-icon name="eye" [size]="16" /> Vista previa</a>
          </header>

          <div class="ed">
            <!-- Contenido -->
            <section class="col-cont">
              <h2>Contenido del curso</h2>

              @for (s of c.secciones; track s.id; let si = $index) {
                <article class="sec">
                  <div class="sec-cab">
                    <span class="sec-n">{{ si + 1 }}</span>
                    <input class="sec-t" aria-label="Título de la sección" [value]="s.titulo" (change)="renombrarSeccion(s, $any($event.target).value)" />
                    <button type="button" class="btn ico" aria-label="Subir sección" [disabled]="si === 0" (click)="moverSeccion(si, -1)"><app-icon name="arrow-up" [size]="15" /></button>
                    <button type="button" class="btn ico" aria-label="Bajar sección" [disabled]="si === c.secciones.length - 1" (click)="moverSeccion(si, 1)"><app-icon name="arrow-down" [size]="15" /></button>
                    <button type="button" class="btn ico peligro" aria-label="Eliminar sección" (click)="borrarSeccion(s)"><app-icon name="trash" [size]="15" /></button>
                  </div>

                  <ul class="lecs">
                    @for (l of s.lecciones; track l.id; let li = $index) {
                      <li class="lec">
                        <span class="l-ico"><app-icon [name]="icono(l.tipo)" [size]="18" /></span>
                        <div class="l-txt">
                          <b>{{ l.titulo }}</b>
                          <small>
                            {{ etiquetaTipo(l.tipo) }}
                            @if (l.duracion_seg) { · {{ duracion(l.duracion_seg) }} }
                            @if (l.archivo_nombre) { · {{ l.archivo_nombre }} }
                            @if (l.url_externa) { · enlace externo }
                            @if (l.vista_previa) { · <span class="gratis">vista previa gratuita</span> }
                          </small>
                        </div>
                        <button type="button" class="btn ico" aria-label="Reproducir lección" title="Reproducir" (click)="previsualizar(l)"><app-icon name="play" [size]="15" /></button>
                        <button type="button" class="btn ico" aria-label="Editar lección" (click)="abrirFormEditar(l)"><app-icon name="pencil" [size]="15" /></button>
                        <button type="button" class="btn ico" aria-label="Subir lección" [disabled]="li === 0" (click)="moverLeccion(s, li, -1)"><app-icon name="arrow-up" [size]="15" /></button>
                        <button type="button" class="btn ico" aria-label="Bajar lección" [disabled]="li === s.lecciones.length - 1" (click)="moverLeccion(s, li, 1)"><app-icon name="arrow-down" [size]="15" /></button>
                        <button type="button" class="btn ico peligro" aria-label="Eliminar lección" (click)="borrarLeccion(l)"><app-icon name="trash" [size]="15" /></button>
                      </li>
                      @if (formEn(s.id, l.id)) { <ng-container [ngTemplateOutlet]="formLeccion" /> }
                    }
                  </ul>

                  @if (formEn(s.id, null)) {
                    <ng-container [ngTemplateOutlet]="formLeccion" />
                  } @else {
                    <button type="button" class="add" (click)="abrirFormNueva(s.id)"><app-icon name="plus" [size]="16" /> Agregar lección</button>
                  }
                </article>
              } @empty {
                <p class="vacio">Este curso aún no tiene secciones. Agrega la primera.</p>
              }

              <div class="sec-nueva">
                <input placeholder="Nueva sección (ej. Introducción)" [value]="nuevaSeccion()" (input)="nuevaSeccion.set($any($event.target).value)"
                       (keyup.enter)="agregarSeccion()" aria-label="Nueva sección" />
                <button type="button" class="btn primary" (click)="agregarSeccion()"><app-icon name="plus" [size]="16" /> Agregar sección</button>
              </div>
            </section>

            <!-- Ajustes -->
            <aside class="col-aj">
              <h2>Ajustes</h2>
              @if (aj(); as a) {
                <div class="card">
                  <label>Título <input [value]="a.titulo" (input)="setA({ titulo: $any($event.target).value })" /></label>
                  <label>Frase corta <input [value]="a.subtitulo" (input)="setA({ subtitulo: $any($event.target).value })" /></label>
                  <label>Descripción
                    <textarea rows="5" [value]="a.descripcion" (input)="setA({ descripcion: $any($event.target).value })"></textarea>
                  </label>
                  <label>Instructor <input [value]="a.instructor" (input)="setA({ instructor: $any($event.target).value })" /></label>
                  <div class="dos">
                    <label>Nivel
                      <select (change)="setA({ nivel: $any($event.target).value })">
                        <option value="todos" [selected]="a.nivel === 'todos'">Todos los niveles</option>
                        <option value="basico" [selected]="a.nivel === 'basico'">Básico</option>
                        <option value="intermedio" [selected]="a.nivel === 'intermedio'">Intermedio</option>
                        <option value="avanzado" [selected]="a.nivel === 'avanzado'">Avanzado</option>
                      </select>
                    </label>
                    <label>Módulo
                      <select (change)="setA({ modulo: $any($event.target).value })">
                        <option value="" [selected]="a.modulo === ''">General</option>
                        @for (m of modulos; track m.id) { <option [value]="m.id" [selected]="a.modulo === m.id">{{ m.label }}</option> }
                      </select>
                    </label>
                  </div>
                </div>

                <div class="card">
                  <h3>Portada</h3>
                  @if (c.portada_id && c.publicado) { <img class="portada" [src]="portadaUrl(c.id)" alt="Portada del curso" (error)="ocultar($event)" /> }
                  @else if (c.portada_id) { <p class="nota">Portada cargada. Se verá al publicar el curso.</p> }
                  @else { <p class="nota">Sin portada: se usará un diseño por módulo.</p> }
                  <label class="subir">
                    <app-icon name="upload" [size]="16" /> {{ c.portada_id ? 'Cambiar portada' : 'Subir portada' }}
                    <input type="file" accept=".png,.jpg,.jpeg,.webp" hidden (change)="onPortada($event)" />
                  </label>
                  @if (subiendo() !== null && subiendoPortada()) { <div class="prog"><span [style.width.%]="subiendo()"></span></div> }
                </div>

                <div class="card">
                  <h3>Publicación</h3>
                  <label class="sw"><input type="checkbox" [checked]="a.publicado" (change)="setA({ publicado: $any($event.target).checked })" /> Publicado</label>
                  <label class="sw"><input type="checkbox" [checked]="a.publico" (change)="setA({ publico: $any($event.target).checked })" /> Mostrar en el sitio público</label>
                  <label class="sw"><input type="checkbox" [checked]="a.destacado" (change)="setA({ destacado: $any($event.target).checked })" /> Destacado</label>
                  <p class="nota">Un curso en borrador solo lo ve el superadmin.</p>
                </div>

                <div class="card">
                  <h3>Acceso por plan</h3>
                  <p class="nota">Si no marcas ninguno, lo ven todos los clientes con acceso al módulo. Marca planes para limitarlo.</p>
                  @for (p of planes(); track p.id) {
                    <label class="sw"><input type="checkbox" [checked]="a.planIds.includes(p.id)" (change)="togglePlan(p.id, $any($event.target).checked)" /> {{ p.nombre }}</label>
                  }
                </div>

                <button type="button" class="btn primary block" (click)="guardarAjustes()"><app-icon name="check" [size]="16" /> Guardar ajustes</button>
                <a class="btn block" [routerLink]="['/anuncios-admin']" [queryParams]="{ curso: c.id }"><app-icon name="megaphone" [size]="16" /> Anunciar este curso</a>
                <button type="button" class="btn block peligro-b" (click)="borrarCurso()"><app-icon name="trash" [size]="16" /> Eliminar curso</button>
              }
            </aside>
          </div>
        }
      }
    </div>

    @if (prev(); as p) {
      <div class="overlay" (click)="cerrarPrev()">
        <div class="modal" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <header class="m-cab">
            <div><small>Vista previa como alumno</small><h3>{{ p.titulo }}</h3></div>
            <button type="button" class="btn ico" aria-label="Cerrar" (click)="cerrarPrev()"><app-icon name="x" [size]="18" /></button>
          </header>
          @if (p.error) {
            <p class="banner bad"><app-icon name="alert" [size]="18" /> {{ p.error }}</p>
          } @else {
            <app-leccion-visor [leccion]="p.leccion" />
          }
        </div>
      </div>
    }

    <!-- ===================== FORMULARIO DE LECCIÓN ===================== -->
    <ng-template #formLeccion>
      @if (fl(); as f) {
        <div class="form-lec">
          <div class="f-fila">
            <label class="f-gr">Título de la lección
              <input [value]="f.titulo" (input)="setF({ titulo: $any($event.target).value })" />
            </label>
            <label>Tipo
              <select (change)="cambiarTipo($any($event.target).value)">
                @for (t of tipos; track t.id) { <option [value]="t.id" [selected]="f.tipo === t.id">{{ t.label }}</option> }
              </select>
            </label>
          </div>

          @if (f.tipo === 'texto') {
            <label>Contenido
              <textarea rows="7" [value]="f.contenido" (input)="setF({ contenido: $any($event.target).value })"></textarea>
            </label>
          } @else {
            @if (f.tipo === 'video') {
              <div class="seg">
                <button type="button" [class.on]="f.modo === 'archivo'" (click)="setF({ modo: 'archivo' })"><app-icon name="upload" [size]="15" /> Subir archivo</button>
                <button type="button" [class.on]="f.modo === 'enlace'" (click)="setF({ modo: 'enlace' })"><app-icon name="link" [size]="15" /> Enlace</button>
              </div>
            }
            @if (f.tipo === 'video' && f.modo === 'enlace') {
              <label>Enlace del video (YouTube, Vimeo o .mp4)
                <input placeholder="https://www.youtube.com/watch?v=..." [value]="f.url"
                       (input)="setF({ url: $any($event.target).value, segundos: null })" (change)="detectarEnlace()" />
              </label>
            } @else {
              <div class="archivo">
                @if (f.archivoId) { <span class="ok-arch"><app-icon name="circle-check" [size]="16" /> {{ f.archivoNombre }}</span> }
                <label class="subir">
                  <app-icon name="upload" [size]="16" /> {{ f.archivoId ? 'Reemplazar archivo' : 'Seleccionar archivo' }}
                  <input type="file" [accept]="acepta(f.tipo)" hidden (change)="onArchivo($event)" />
                </label>
                <small class="nota">Formatos: {{ acepta(f.tipo) }}</small>
                @if (subiendo() !== null && !subiendoPortada()) { <div class="prog"><span [style.width.%]="subiendo()"></span></div> }
              </div>
            }
          }

          <label class="sw">
            <input type="checkbox" [checked]="f.vistaPrevia" (change)="setF({ vistaPrevia: $any($event.target).checked })" />
            Vista previa gratuita (se puede ver en la página pública sin comprar)
          </label>
          <label class="f-min">Duración (minutos)
            <input type="number" min="0" [value]="f.minutos" (input)="setF({ minutos: $any($event.target).value, segundos: null })" />
            @if (detectando()) {
              <small class="nota">Calculando la duración…</small>
            } @else if (f.segundos) {
              <small class="auto"><app-icon name="circle-check" [size]="13" /> Duración detectada automáticamente: {{ segTxt(f.segundos) }}</small>
            } @else if (f.tipo === 'video' || f.tipo === 'audio') {
              <small class="nota">Se calcula sola al subir el archivo o pegar el enlace. Si no se puede, escríbela.</small>
            }
          </label>

          <div class="f-acc">
            <button type="button" class="btn primary" [disabled]="subiendo() !== null" (click)="guardarLeccion()">Guardar lección</button>
            <button type="button" class="btn" (click)="cerrarForm()">Cancelar</button>
          </div>
        </div>
      }
    </ng-template>
  `,
  styles: [`
    :host { display: block; color: #0f172a; --brand: #1d4ed8; --navy: #0a1a3a; --line: #e2e8f4; --muted: #5a6784; --soft: #eef2ff; }
    * { box-sizing: border-box; }
    .wrap { max-width: 1240px; margin: 0 auto; padding: 24px 20px 80px; }
    .banner { display: flex; align-items: center; gap: 10px; margin: 0 0 14px; padding: 12px 16px; border-radius: 12px; font-size: .9rem; }
    .banner.ok { background: #d1fae5; color: #047857; } .banner.bad { background: #fef2f2; color: #b91c1c; }
    .eyebrow { font-size: .72rem; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--brand); }
    h1 { margin: 4px 0 4px; font-size: 1.6rem; letter-spacing: -.02em; } h2 { margin: 0 0 14px; font-size: 1.1rem; } h3 { margin: 0 0 8px; font-size: .95rem; }
    .sub { margin: 0 0 18px; color: var(--muted); font-size: .92rem; } .nota { margin: 4px 0 8px; color: var(--muted); font-size: .8rem; line-height: 1.5; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 38px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--line); background: #fff;
      color: #0f172a; font: inherit; font-size: .85rem; font-weight: 600; text-decoration: none; cursor: pointer; transition: .15s; }
    .btn:hover:not(:disabled) { border-color: #c3cde6; } .btn:disabled { opacity: .45; cursor: not-allowed; }
    .btn.primary { background: var(--brand); border-color: var(--brand); color: #fff; } .btn.primary:hover:not(:disabled) { background: #1a43b8; }
    .btn.ico { width: 36px; padding: 0; } .btn.peligro { color: #b91c1c; } .btn.peligro:hover:not(:disabled) { background: #fef2f2; border-color: #fecaca; }
    .btn.block { width: 100%; margin-top: 10px; } .peligro-b { color: #b91c1c; }
    .nuevo { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 14px; margin-bottom: 20px; background: #fff; border: 1px dashed #c3cde6; border-radius: 14px; color: var(--muted); }
    .nuevo input { flex: 1; min-width: 220px; }
    input:not([type=checkbox]):not([type=file]), select, textarea { padding: 9px 12px; border: 1px solid #cbd5e1; border-radius: 10px; font: inherit; font-size: .9rem; background: #fff; color: #0f172a; }
    input:not([type=checkbox]):not([type=file]), select { height: 40px; } textarea { resize: vertical; width: 100%; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 18px; }
    .tarjeta { overflow: hidden; background: #fff; border: 1px solid var(--line); border-radius: 16px; transition: .2s; }
    .tarjeta:hover { box-shadow: 0 20px 40px -26px rgb(10 26 58 / .5); transform: translateY(-2px); }
    .thumb { position: relative; display: grid; place-items: center; height: 150px; color: rgb(255 255 255 / .9); background: linear-gradient(135deg, #334155, #64748b); overflow: hidden; }
    .thumb[data-m='perucompras'] { background: linear-gradient(135deg, #0a1a3a, #1d4ed8); }
    .thumb[data-m='menor'] { background: linear-gradient(135deg, #112a5e, #2f6bff); }
    .thumb[data-m='mayor'] { background: linear-gradient(135deg, #3a0f24, #c8102e); }
    .thumb img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; } .t-ico { position: relative; z-index: 0; opacity: .85; }
    .estado { position: absolute; top: 10px; left: 10px; z-index: 1; padding: 3px 10px; border-radius: 999px; font-size: .7rem; font-weight: 700; color: #475569; background: #e2e8f0; }
    .estado.on { color: #047857; background: #d1fae5; } .b-tit .estado { position: static; }
    .t-body { display: flex; flex-direction: column; gap: 6px; padding: 16px; }
    .mod { width: fit-content; padding: 2px 10px; border-radius: 999px; font-size: .7rem; font-weight: 600; color: var(--brand); background: var(--soft); }
    .t-body h3 { margin: 2px 0 0; font-size: 1rem; line-height: 1.35; } .t-body small { color: var(--muted); }
    .t-acc { display: flex; gap: 8px; margin-top: 8px; } .t-acc .primary { flex: 1; }
    .vacio { grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--muted); background: #fff; border: 1px dashed #c3cde6; border-radius: 14px; }
    .barra-ed { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; flex-wrap: wrap; }
    .b-tit { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 200px; } .b-tit h1 { margin: 0; font-size: 1.3rem; }
    .ed { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 24px; align-items: start; }
    .sec { margin-bottom: 16px; padding: 14px; background: #fff; border: 1px solid var(--line); border-radius: 16px; }
    .sec-cab { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .sec-n { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; font-weight: 700; font-size: .85rem; color: #fff; background: var(--navy); flex: none; }
    .sec-t { flex: 1; min-width: 0; font-weight: 600; }
    .lecs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .lec { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: #f8faff; border: 1px solid var(--line); border-radius: 12px; }
    .l-ico { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; color: var(--brand); background: var(--soft); flex: none; }
    .l-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; } .l-txt b { font-size: .9rem; } .l-txt small { color: var(--muted); font-size: .76rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .add { display: inline-flex; align-items: center; gap: 8px; margin-top: 10px; padding: 9px 14px; border: 1px dashed #aab8dc; border-radius: 10px; background: none; color: var(--brand); font: inherit; font-size: .86rem; font-weight: 600; cursor: pointer; }
    .add:hover { background: var(--soft); }
    .sec-nueva { display: flex; gap: 10px; flex-wrap: wrap; padding: 14px; background: #fff; border: 1px dashed #c3cde6; border-radius: 14px; } .sec-nueva input { flex: 1; min-width: 200px; }
    .form-lec { display: flex; flex-direction: column; gap: 12px; margin: 4px 0 8px; padding: 14px; background: #fff; border: 2px solid #c7d6fb; border-radius: 14px; }
    .f-fila { display: flex; gap: 12px; flex-wrap: wrap; } .f-gr { flex: 1; min-width: 200px; } .f-min { max-width: 200px; }
    label { display: flex; flex-direction: column; gap: 6px; font-size: .8rem; font-weight: 600; color: #334155; }
    .seg { display: inline-flex; width: fit-content; padding: 3px; background: #e8edf8; border-radius: 11px; }
    .seg button { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border: 0; border-radius: 8px; background: none; font: inherit; font-size: .82rem; font-weight: 600; color: var(--muted); cursor: pointer; }
    .seg button.on { background: #fff; color: #0f172a; box-shadow: 0 1px 3px rgb(10 26 58 / .15); }
    .archivo { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; } .ok-arch { display: inline-flex; align-items: center; gap: 6px; color: #047857; font-size: .85rem; font-weight: 600; }
    .subir { display: inline-flex; flex-direction: row; align-items: center; gap: 8px; width: fit-content; padding: 9px 14px; border: 1px solid var(--line); border-radius: 10px; background: #fff; color: #0f172a; font-size: .85rem; font-weight: 600; cursor: pointer; }
    .subir:hover { border-color: #c3cde6; background: #f8faff; }
    .prog { flex-basis: 100%; height: 6px; border-radius: 999px; background: #e2e8f4; overflow: hidden; } .prog span { display: block; height: 100%; background: var(--brand); transition: width .2s; }
    .f-acc { display: flex; gap: 10px; }
    .col-aj { position: sticky; top: 80px; } .col-aj .card { display: flex; flex-direction: column; gap: 12px; margin-bottom: 14px; padding: 16px; background: #fff; border: 1px solid var(--line); border-radius: 16px; }
    .dos { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; } .portada { width: 100%; border-radius: 10px; aspect-ratio: 16 / 9; object-fit: cover; }
    .sw { flex-direction: row; align-items: center; gap: 10px; font-weight: 500; } .sw input { width: 17px; height: 17px; accent-color: var(--brand); }
    .gratis { color: #047857; font-weight: 700; }
    .auto { display: inline-flex; align-items: center; gap: 6px; color: #047857; font-size: .78rem; font-weight: 600; }
    .overlay { position: fixed; inset: 0; z-index: 80; display: grid; place-items: start center; padding: 24px 16px; background: rgb(8 18 44 / .65); overflow-y: auto; }
    .modal { width: min(960px, 100%); display: flex; flex-direction: column; gap: 14px; padding: 20px; background: #fff; border-radius: 18px; box-shadow: 0 40px 90px -30px rgb(0 0 0 / .7); }
    .m-cab { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; } .m-cab small { color: var(--muted); font-size: .76rem; } .m-cab h3 { margin: 2px 0 0; font-size: 1.1rem; }
    @media (max-width: 980px) { .ed { grid-template-columns: 1fr; } .col-aj { position: static; } }
  `],
})
export class CursosAdminPage implements OnInit {
  private readonly api: AprendeAdminService = inject(AprendeAdminService);
  private readonly catalogo: CatalogoService = inject(CatalogoService);
  readonly modulos = MODULOS;
  readonly tipos = TIPOS;

  readonly vista = signal<Vista>('lista');
  readonly cursos = signal<CursoResumen[]>([]);
  readonly curso = signal<CursoDetalle | null>(null);
  readonly planes = signal<{ id: number; nombre: string }[]>([]);
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');

  readonly ncTitulo = signal<string>('');
  readonly ncModulo = signal<string>('');
  readonly aj = signal<Ajustes | null>(null);
  readonly fl = signal<FormLeccion | null>(null);
  readonly nuevaSeccion = signal<string>('');
  readonly subiendo = signal<number | null>(null);
  readonly subiendoPortada = signal<boolean>(false);
  private readonly aprende: AprendeService = inject(AprendeService);
  readonly prev = signal<{ titulo: string; leccion: LeccionCarga | null; error: string } | null>(null);

  ngOnInit(): void {
    this.cargarCursos();
    this.catalogo.planes().subscribe({
      next: (l) => this.planes.set(l.map((p) => ({ id: p.id, nombre: p.nombre }))),
      error: () => undefined,
    });
  }

  // ---------------- Utilidades de pantalla ----------------
  private ok(t: string): void { this.error.set(''); this.mensaje.set(t); }
  private fallo(e: HttpErrorResponse): void { this.mensaje.set(''); this.error.set(this.msg(e)); }
  portadaUrl(id: number): string { return `${API}/publico/portadas/${id}`; }
  ocultar(ev: Event): void { (ev.target as HTMLImageElement).style.display = 'none'; }
  moduloNombre(m: string | null): string { return MODULOS.find((x) => x.id === m)?.label ?? 'General'; }
  vistaPrevia(c: CursoDetalle): string[] { return ['/', c.modulo ?? 'perucompras', 'capacitacion', String(c.id)]; }
  etiquetaTipo(t: TipoLeccion): string { return TIPOS.find((x) => x.id === t)?.label ?? t; }
  acepta(t: TipoLeccion): string { return ACEPTA[t]; }
  icono(t: TipoLeccion): IconName {
    return ({ video: 'video', audio: 'headphones', documento: 'file', imagen: 'image', texto: 'align-left' } as const)[t];
  }
  duracion(seg: number): string {
    if (!seg) return 'Sin duración';
    const m = Math.max(1, Math.round(seg / 60));
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  }

  // ---------------- Lista ----------------
  cargarCursos(): void {
    this.api.cursos().subscribe({ next: (l) => this.cursos.set(l), error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  crearCurso(): void {
    if (this.ncTitulo().trim().length < 3) { this.mensaje.set(''); this.error.set('Escribe un título de al menos 3 letras'); return; }
    this.api.crearCurso({ titulo: this.ncTitulo().trim(), modulo: (this.ncModulo() || null) as ModuloCurso | null }).subscribe({
      next: (r) => { this.ncTitulo.set(''); this.abrir(r.id); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  moverCurso(i: number, d: number): void {
    const l = [...this.cursos()];
    const j = i + d;
    if (j < 0 || j >= l.length) return;
    [l[i], l[j]] = [l[j], l[i]];
    this.cursos.set(l);
    this.api.ordenarCursos(l.map((c) => c.id)).subscribe({ error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  // ---------------- Editor ----------------
  abrir(id: number): void {
    this.mensaje.set(''); this.error.set(''); this.fl.set(null);
    this.api.curso(id).subscribe({
      next: (c) => {
        this.curso.set(c);
        this.aj.set({
          titulo: c.titulo, subtitulo: c.subtitulo, descripcion: c.descripcion, instructor: c.instructor, nivel: c.nivel,
          modulo: c.modulo ?? '', publicado: c.publicado, publico: c.publico, destacado: c.destacado, planIds: [...c.plan_ids],
        });
        this.vista.set('editor');
        window.scrollTo({ top: 0 });
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  volver(): void { this.vista.set('lista'); this.curso.set(null); this.fl.set(null); this.cargarCursos(); }

  /** Vuelve a leer el curso (sin tocar los ajustes que estés escribiendo). */
  private recargar(aviso?: string): void {
    const c = this.curso();
    if (!c) return;
    this.api.curso(c.id).subscribe({
      next: (n) => { this.curso.set(n); if (aviso) this.ok(aviso); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  setA(cambio: Partial<Ajustes>): void { this.aj.update((a) => (a ? { ...a, ...cambio } : a)); }

  togglePlan(id: number, on: boolean): void {
    const a = this.aj();
    if (a) this.setA({ planIds: on ? [...new Set([...a.planIds, id])] : a.planIds.filter((x) => x !== id) });
  }

  guardarAjustes(): void {
    const c = this.curso();
    const a = this.aj();
    if (!c || !a) return;
    const cuerpo: Record<string, unknown> = {
      titulo: a.titulo.trim(), subtitulo: a.subtitulo.trim(), descripcion: a.descripcion.trim(),
      instructor: a.instructor.trim(), nivel: a.nivel, publicado: a.publicado, publico: a.publico, destacado: a.destacado,
      ...(a.modulo ? { modulo: a.modulo } : { sin_modulo: true }),
    };
    forkJoin([this.api.editarCurso(c.id, cuerpo), this.api.fijarPlanes(c.id, a.planIds)]).subscribe({
      next: () => this.recargar('Ajustes guardados'),
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  borrarCurso(): void {
    const c = this.curso();
    if (!c || !confirm(`¿Eliminar el curso "${c.titulo}" con todas sus lecciones y archivos? No se puede deshacer.`)) return;
    this.api.borrarCurso(c.id).subscribe({
      next: () => { this.volver(); this.ok('Curso eliminado'); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  // ---------------- Secciones ----------------
  agregarSeccion(): void {
    const c = this.curso();
    const t = this.nuevaSeccion().trim();
    if (!c || t.length < 2) { this.mensaje.set(''); this.error.set('Escribe el nombre de la sección'); return; }
    this.api.crearSeccion(c.id, t).subscribe({
      next: () => { this.nuevaSeccion.set(''); this.recargar(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  renombrarSeccion(s: SeccionAdmin, titulo: string): void {
    const t = titulo.trim();
    if (t.length < 2 || t === s.titulo) { this.recargar(); return; }
    this.api.renombrarSeccion(s.id, t).subscribe({ next: () => this.recargar('Sección renombrada'), error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  borrarSeccion(s: SeccionAdmin): void {
    if (!confirm(`¿Eliminar la sección "${s.titulo}" y sus ${s.lecciones.length} lecciones?`)) return;
    this.api.borrarSeccion(s.id).subscribe({ next: () => this.recargar('Sección eliminada'), error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  moverSeccion(i: number, d: number): void {
    const c = this.curso();
    if (!c) return;
    const l = [...c.secciones];
    const j = i + d;
    if (j < 0 || j >= l.length) return;
    [l[i], l[j]] = [l[j], l[i]];
    this.api.ordenarSecciones(c.id, l.map((s) => s.id)).subscribe({ next: () => this.recargar(), error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  // ---------------- Lecciones ----------------
  formEn(seccionId: number, leccionId: number | null): boolean {
    const f = this.fl();
    return !!f && f.seccionId === seccionId && f.id === leccionId;
  }

  abrirFormNueva(seccionId: number): void {
    this.error.set('');
    this.fl.set({ seccionId, id: null, titulo: '', tipo: 'video', modo: 'archivo', archivoId: null, archivoNombre: '', url: '', contenido: '', minutos: '', vistaPrevia: this.totalLecciones() === 0, segundos: null });
  }

  abrirFormEditar(l: LeccionAdmin): void {
    this.error.set('');
    this.fl.set({
      seccionId: l.seccion_id, id: l.id, titulo: l.titulo, tipo: l.tipo, modo: l.url_externa ? 'enlace' : 'archivo',
      archivoId: l.archivo_id, archivoNombre: l.archivo_nombre ?? '', url: l.url_externa ?? '', contenido: l.contenido,
      minutos: l.duracion_seg ? String(Math.round(l.duracion_seg / 60)) : '',
      vistaPrevia: l.vista_previa, segundos: l.duracion_seg || null,
    });
  }

  cerrarForm(): void { this.fl.set(null); this.subiendo.set(null); }

  totalLecciones(): number {
    return (this.curso()?.secciones ?? []).reduce((n, s) => n + s.lecciones.length, 0);
  }

  /** Reproduce la lección tal como la verá el alumno. */
  previsualizar(l: LeccionAdmin): void {
    this.prev.set({ titulo: l.titulo, leccion: null, error: '' });
    this.aprende.leccion(l.id).subscribe({
      next: (x) => this.prev.update((p) => (p ? { ...p, leccion: x } : p)),
      error: (e: HttpErrorResponse) => this.prev.update((p) => (p ? { ...p, error: this.msg(e) } : p)),
    });
  }

  cerrarPrev(): void { this.prev.set(null); }

  readonly detectando = signal<boolean>(false);

  /** Calcula la duración sola; si no se puede, queda la caja de minutos para escribirla. */
  private detectar(medir: () => Promise<number>): void {
    this.detectando.set(true);
    medir()
      .then((seg) => this.setF({ segundos: seg, minutos: String(Math.max(1, Math.round(seg / 60))) }))
      .catch(() => undefined)
      .finally(() => this.detectando.set(false));
  }

  /** Al pegar un enlace de YouTube, Vimeo o .mp4 se calcula la duración. */
  detectarEnlace(): void {
    const f = this.fl();
    const url = f?.url.trim() ?? '';
    if (!f || f.tipo !== 'video' || !url) return;
    const yt = idYoutube(url);
    if (yt) this.detectar(() => duracionYoutube(yt));
    else if (/vimeo\.com/i.test(url)) this.detectar(() => duracionVimeo(url));
    else if (/\.(mp4|webm)(\?.*)?$/i.test(url)) this.detectar(() => duracionDeUrl(url));
  }

  segTxt(seg: number | null): string {
    if (!seg) return '';
    return `${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, '0')}`;
  }
  setF(cambio: Partial<FormLeccion>): void { this.fl.update((f) => (f ? { ...f, ...cambio } : f)); }

  cambiarTipo(t: TipoLeccion): void {
    this.setF({ tipo: t, modo: 'archivo', archivoId: null, archivoNombre: '', url: '' });
  }

  private subirArchivo(file: File, esPortada: boolean, alTerminar: (a: ArchivoSubido) => void): void {
    this.error.set('');
    this.subiendoPortada.set(esPortada);
    this.subiendo.set(0);
    this.api.subir(file).subscribe({
      next: (ev) => {
        if (ev.type === HttpEventType.UploadProgress && ev.total) {
          this.subiendo.set(Math.round((ev.loaded / ev.total) * 100));
        } else if (ev.type === HttpEventType.Response && ev.body) {
          this.subiendo.set(null);
          alTerminar(ev.body);
        }
      },
      error: (e: HttpErrorResponse) => { this.subiendo.set(null); this.fallo(e); },
    });
  }

  onArchivo(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const f = this.fl();
    if (f && (f.tipo === 'video' || f.tipo === 'audio')) this.detectar(() => duracionDeArchivo(file));
    this.subirArchivo(file, false, (a) => this.setF({ archivoId: a.id, archivoNombre: a.nombre }));
  }

  onPortada(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const c = this.curso();
    if (!file || !c) return;
    this.subirArchivo(file, true, (a) => {
      this.api.editarCurso(c.id, { portada_id: a.id }).subscribe({
        next: () => this.recargar('Portada actualizada'),
        error: (e: HttpErrorResponse) => this.fallo(e),
      });
    });
  }

  guardarLeccion(): void {
    const f = this.fl();
    if (!f) return;
    if (f.titulo.trim().length < 2) { this.mensaje.set(''); this.error.set('Escribe el título de la lección'); return; }
    const porEnlace = f.tipo === 'video' && f.modo === 'enlace';
    const body: LeccionBody = {
      titulo: f.titulo.trim(), tipo: f.tipo,
      archivo_id: f.tipo !== 'texto' && !porEnlace ? f.archivoId : null,
      url_externa: porEnlace ? f.url.trim() : null,
      contenido: f.tipo === 'texto' ? f.contenido : '',
      duracion_seg: f.segundos ?? Math.round((Number(f.minutos) || 0) * 60),
      vista_previa: f.vistaPrevia,
    };
    const obs = f.id === null ? this.api.crearLeccion(f.seccionId, body) : this.api.editarLeccion(f.id, body);
    obs.subscribe({
      next: () => { this.cerrarForm(); this.recargar('Lección guardada'); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  borrarLeccion(l: LeccionAdmin): void {
    if (!confirm(`¿Eliminar la lección "${l.titulo}"?`)) return;
    this.api.borrarLeccion(l.id).subscribe({ next: () => this.recargar('Lección eliminada'), error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  moverLeccion(s: SeccionAdmin, i: number, d: number): void {
    const l = [...s.lecciones];
    const j = i + d;
    if (j < 0 || j >= l.length) return;
    [l[i], l[j]] = [l[j], l[i]];
    this.api.ordenarLecciones(s.id, l.map((x) => x.id)).subscribe({ next: () => this.recargar(), error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  private msg(e: HttpErrorResponse): string {
    const d = e.error?.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return 'Revisa los datos: hay campos vacíos o demasiado cortos.';
    if (e.status === 413) return 'El archivo es demasiado grande para el servidor.';
    return 'No se pudo conectar con el servidor';
  }
}