import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import { IconComponent } from '../../shared/icon.component';
import { Canal } from './crm-whatsapp.service';
import { ArchivoCrm, ArchivosService } from './crm-archivos.service';
import { CrmFlujoEditorComponent } from './crm-flujo-editor.component';
import {
  AutomatizacionesService, ConfigIa, Definicion, EjecucionFlujo, FlujoResumen, Nodo, PlantillaFlujo, RegistroFlujo, ResultadoPrueba,
} from './crm-automatizaciones.service';

interface CampoNodo { k: string; label: string; t: 'texto' | 'area' | 'numero' | 'palabras' | 'unidad'; }
interface Edicion { id: number; nombre: string; canal: Canal; canal_id: number | null; def: Definicion; }

const CANALES: { id: Canal; label: string }[] = [
  { id: 'whatsapp', label: 'WhatsApp' }, { id: 'facebook', label: 'Messenger' }, { id: 'instagram', label: 'Instagram' },
];
const EVENTOS: Record<string, string> = {
  mensaje_entrante: 'Mensaje entrante', palabra_clave: 'Palabra clave', lead_nuevo: 'Lead nuevo', sin_respuesta: 'Cliente sin responder',
};
const NODOS: Record<string, string> = {
  disparador: 'Inicio', mensaje: 'Enviar mensaje', plantilla: 'Plantilla de WhatsApp', ia: 'Responder con IA', esperar: 'Esperar',
  esperar_respuesta: 'Esperar respuesta', condicion: 'Condición', asignar: 'Asignar ejecutivo', etapa: 'Cambiar etapa', nota: 'Agregar nota',
  tarea: 'Crear tarea', fin: 'Fin',
};
const ESTADOS: Record<string, string> = {
  activa: 'En cola', procesando: 'Ejecutándose', esperando: 'Esperando', esperando_respuesta: 'Esperando respuesta',
  completada: 'Completada', error: 'Con error', cancelada: 'Cancelada',
};
const UNIDADES = [{ id: 'minutos', label: 'minutos' }, { id: 'horas', label: 'horas' }, { id: 'dias', label: 'días' }];

function camposDe(n: Nodo): CampoNodo[] {
  const c = n.config;
  switch (n.tipo) {
    case 'disparador': return [
      ...(c['evento'] === 'palabra_clave' ? [{ k: 'palabras', label: 'Palabras clave (separadas por coma)', t: 'palabras' as const }] : []),
      ...(c['evento'] === 'sin_respuesta' ? [{ k: 'minutos', label: 'Minutos sin respuesta del cliente (mínimo 5)', t: 'numero' as const }] : []),
      { k: 'repetir_horas', label: 'No repetir con la misma persona antes de (horas; 0 = siempre)', t: 'numero' as const },
    ];
    case 'mensaje': return [{ k: 'texto', label: 'Mensaje (puedes usar {{primer_nombre}}, {{nombre}}, {{mensaje}})', t: 'area' }];
    case 'ia': return [
      { k: 'instrucciones', label: 'Instrucciones para esta conversación (qué debe hacer la IA)', t: 'area' },
      { k: 'pausa_horas', label: 'Si pasa a una persona, la IA calla (horas)', t: 'numero' },
    ];
    case 'esperar': case 'esperar_respuesta': return [
      { k: 'cantidad', label: 'Esperar', t: 'numero' }, { k: 'unidad', label: 'Unidad', t: 'unidad' },
    ];
    case 'condicion': return c['campo'] === 'horario'
      ? [{ k: 'desde', label: 'Desde (HH:MM)', t: 'texto' }, { k: 'hasta', label: 'Hasta (HH:MM)', t: 'texto' }]
      : [{ k: 'valor', label: 'Valor a comparar', t: 'texto' }];
    case 'nota': return [{ k: 'texto', label: 'Texto de la nota', t: 'area' }];
    case 'tarea': return [{ k: 'texto', label: 'Texto de la tarea', t: 'area' }, { k: 'horas', label: 'Vence en (horas)', t: 'numero' }];
    default: return [];
  }
}

@Component({
  selector: 'app-crm-automatizaciones',
  imports: [IconComponent, CrmFlujoEditorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (mensaje()) { <p class="ok"><app-icon name="circle-check" [size]="18" /> {{ mensaje() }}</p> }
    @if (error()) { <p class="error"><app-icon name="alert" [size]="18" /> {{ error() }}</p> }

    <section class="card">
      <div class="fila">
        <div class="grande">
          <h3>Asistente de IA</h3>
          <p class="nota">Lo usan los pasos «Responder con IA». Elige un proveedor con plan gratuito, pega su clave y escribe la información de tu empresa para que la IA no invente datos.</p>
        </div>
        <span class="estado" [class.ok]="cfgIa()?.clave_guardada">{{ cfgIa()?.clave_guardada ? 'Configurado' : 'Sin configurar' }}</span>
      </div>
      @if (cfgIa(); as c) {
        <div class="grid2">
          <label>Proveedor
            <select (change)="cambiarProveedor($any($event.target).value)">
              @for (p of c.proveedores; track p.id) { <option [value]="p.id" [selected]="fp() === p.id">{{ p.nombre }}{{ p.gratis ? ' · plan gratuito' : ' · de pago' }}</option> }
            </select>
          </label>
          <label>Modelo <input [value]="fm()" (input)="fm.set($any($event.target).value)" /></label>
          <div class="modelos ancho2">
            <button type="button" class="btn" [disabled]="ocupado()" (click)="verModelos()">Ver modelos disponibles para mi clave</button>
            @if (listaModelos().length) {
              <select aria-label="Modelos disponibles" (change)="elegirModelo($any($event.target).value)">
                <option value="">Elige uno de la lista…</option>
                @for (m of listaModelos(); track m.id) {
                  <option [value]="m.id" [selected]="fm() === m.id">{{ m.id }}{{ m.recomendado ? ' · recomendado (plan gratuito)' : '' }}</option>
                }
              </select>
            }
          </div>
          <label>Clave de API
            <input type="password" autocomplete="new-password" [value]="fk()" (input)="fk.set($any($event.target).value)" [placeholder]="c.clave_guardada ? 'Guardada. Escribe solo para cambiarla' : 'Pega la clave'" />
          </label>
          <label>Máximo de respuestas de IA por día <input type="number" min="10" max="5000" [value]="fd()" (input)="fd.set($any($event.target).value)" /></label>
          <label class="ancho2">Información de tu empresa para la IA (servicios, horarios, políticas, preguntas frecuentes)
            <textarea rows="6" maxlength="3000" [value]="fx()" (input)="fx.set($any($event.target).value)"></textarea>
          </label>
        </div>
        <p class="nota">Consigue la clave en: <b>{{ urlClave() }}</b>. En los planes gratuitos el proveedor puede aplicar límites por minuto y por día. Los límites cambian: revísalos en su consola.</p>
        <div class="fila acciones">
          <button type="button" class="btn" [disabled]="ocupado() || !c.clave_guardada" (click)="probarIa()">Probar IA</button>
          <button type="button" class="btn primary" [disabled]="ocupado()" (click)="guardarIa()">Guardar</button>
        </div>
      }
    </section>

    <section class="card">
      <div class="fila-sb"><h3>Flujos de automatización</h3>
        <button type="button" class="btn primary" (click)="abrirNuevo()"><app-icon name="plus" [size]="16" /> Nuevo flujo</button></div>
      <p class="nota">Cada flujo trabaja en un solo canal. Antes de publicar, usa «Probar» (no envía nada). Una vez publicado, responde de verdad a tus clientes. Si una persona escribe al cliente, el flujo se detiene.</p>
      @for (f of flujos(); track f.id) {
        <article class="flujo">
          <div class="f-t">
            <b>{{ f.nombre }}</b>
            <small>{{ canal(f.canal) }} · {{ evento(f.evento) }} · {{ f.en_curso }} en curso · {{ f.ultimos7 }} en 7 días</small>
            @if (f.cambios_sin_publicar) { <small class="aviso-t">Tiene cambios sin publicar</small> }
          </div>
          <span class="tag" [class.si]="f.estado === 'publicado'">{{ f.estado === 'publicado' ? 'Publicado' : 'Borrador' }}</span>
          <div class="fila">
            <button type="button" class="btn" (click)="abrirPrueba(f)">Probar</button>
            <button type="button" class="btn primary" (click)="editorId.set(f.id)">Abrir editor</button>
            <button type="button" class="btn" (click)="abrirEdicion(f)">Editar textos</button>
            <button type="button" class="btn" (click)="abrirEjecuciones(f)">Ejecuciones</button>
            @if (f.estado === 'publicado' && !f.cambios_sin_publicar) { <button type="button" class="btn" (click)="pausar(f)">Pausar</button> }
            @else { <button type="button" class="btn primary" (click)="publicar(f)">Publicar</button> }
            <button type="button" class="btn peligro" (click)="borrar(f)"><app-icon name="trash" [size]="14" /></button>
          </div>
        </article>
      } @empty { <p class="nota">Todavía no hay flujos. Crea el primero desde una plantilla.</p> }
    </section>

    <section class="card">
      <div class="fila-sb">
        <h3>Archivos para flujos</h3>
        <label class="btn primary">Subir archivo
          <input type="file" hidden accept="image/jpeg,image/png,video/mp4,video/3gpp,audio/mpeg,audio/ogg,audio/aac,audio/mp4,audio/amr,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt" (change)="subirArchivo($any($event.target))" />
        </label>
      </div>
      <p class="nota">Imágenes, audios, videos y documentos que tus flujos pueden enviar con el paso «Enviar archivo» o como imagen de un menú con botones. Máximo 16 MB (imágenes, 5 MB).</p>
      @for (a of archivos(); track a.id) {
        <article class="flujo">
          <div class="f-t"><b>{{ a.nombre }}</b><small>{{ a.categoria }} · {{ tamano(a.tamano) }}</small></div>
          <div class="fila">
            <button type="button" class="btn" (click)="verArchivo(a)">Descargar</button>
            <button type="button" class="btn peligro" (click)="borrarArchivo(a)"><app-icon name="trash" [size]="14" /></button>
          </div>
        </article>
      } @empty { <p class="nota">Todavía no subiste archivos.</p> }
    </section>

    @if (editorId(); as eid) {
      <app-crm-flujo-editor [flujoId]="eid" (cerrar)="editorId.set(null)" (cambio)="cargar()" />
    }

    @if (nuevo()) {
      <div class="overlay" (click)="nuevo.set(false)">
        <div class="modal" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <header class="m-cab"><h3>Nuevo flujo</h3><button type="button" class="btn ico" aria-label="Cerrar" (click)="nuevo.set(false)"><app-icon name="x" [size]="18" /></button></header>
          <label>Nombre <input [value]="nNombre()" (input)="nNombre.set($any($event.target).value)" /></label>
          <label>Canal
            <select (change)="nCanal.set($any($event.target).value)">
              @for (c of canales; track c.id) { <option [value]="c.id" [selected]="nCanal() === c.id">{{ c.label }}</option> }
            </select>
          </label>
          <label>Empezar desde
            <select (change)="nPlantilla.set($any($event.target).value)">
              @for (p of plantillas(); track p.id) { <option [value]="p.id" [selected]="nPlantilla() === p.id">{{ p.nombre }}</option> }
              <option value="" [selected]="nPlantilla() === ''">Flujo en blanco</option>
            </select>
          </label>
          @if (descPlantilla(); as d) { <p class="nota">{{ d }}</p> }
          <div class="pie">
            <button type="button" class="btn" (click)="nuevo.set(false)">Cancelar</button>
            <button type="button" class="btn primary" [disabled]="ocupado()" (click)="crear()">Crear flujo</button>
          </div>
        </div>
      </div>
    }

    @if (ed(); as e) {
      <div class="overlay" (click)="ed.set(null)">
        <div class="modal ancho" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <header class="m-cab"><h3>Editar textos: {{ e.nombre }}</h3><button type="button" class="btn ico" aria-label="Cerrar" (click)="ed.set(null)"><app-icon name="x" [size]="18" /></button></header>
          <label>Nombre del flujo <input [value]="e.nombre" (input)="nombreFlujo($any($event.target).value)" /></label>
          @for (n of ordenados(); track n.id) {
            @if (camposDe(n).length) {
              <div class="paso">
                <b>{{ tipoNodo(n.tipo) }}@if (n.config['rotulo']) { · {{ n.config['rotulo'] }} }</b>
                @for (k of camposDe(n); track k.k) {
                  <label>{{ k.label }}
                    @switch (k.t) {
                      @case ('area') { <textarea rows="3" [value]="leer(n, k)" (input)="poner(n.id, k, $any($event.target).value)"></textarea> }
                      @case ('unidad') {
                        <select (change)="poner(n.id, k, $any($event.target).value)">
                          @for (u of unidades; track u.id) { <option [value]="u.id" [selected]="leer(n, k) === u.id">{{ u.label }}</option> }
                        </select>
                      }
                      @default { <input [type]="k.t === 'numero' ? 'number' : 'text'" [value]="leer(n, k)" (input)="poner(n.id, k, $any($event.target).value)" /> }
                    }
                  </label>
                }
              </div>
            }
          }
          <p class="nota">La estructura (qué paso va después de cuál) se edita con el lienzo visual de la siguiente fase. Después de guardar, pulsa «Publicar» en la lista.</p>
          <div class="pie">
            <button type="button" class="btn" (click)="ed.set(null)">Cancelar</button>
            <button type="button" class="btn primary" [disabled]="ocupado()" (click)="guardarEdicion()">Guardar borrador</button>
          </div>
        </div>
      </div>
    }

    @if (pr(); as p) {
      <div class="overlay" (click)="pr.set(null)">
        <div class="modal ancho" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <header class="m-cab"><h3>Probar: {{ p.nombre }}</h3><button type="button" class="btn ico" aria-label="Cerrar" (click)="pr.set(null)"><app-icon name="x" [size]="18" /></button></header>
          <p class="nota">No envía nada ni llama a la IA: solo recorre el flujo para mostrarte qué haría.</p>
          <label>Mensaje que escribe el cliente <input [value]="pMensaje()" (input)="pMensaje.set($any($event.target).value)" /></label>
          <label>Si el flujo espera una respuesta, el cliente contesta <input [value]="pRespuesta()" (input)="pRespuesta.set($any($event.target).value)" /></label>
          <label class="chk"><input type="checkbox" [checked]="pSin()" (change)="pSin.set($any($event.target).checked)" /> El cliente NO responde a tiempo</label>
          <div class="fila acciones"><button type="button" class="btn primary" [disabled]="ocupado()" (click)="ejecutarPrueba()">Probar</button></div>
          @if (resultado(); as r) {
            @if (!r.coincide) { <p class="error">{{ r.motivo }}</p> }
            <ol class="pasos">
              @for (s of r.pasos; track $index) {
                <li><b>{{ tipoNodo(s.tipo) }}@if (s.rotulo) { · {{ s.rotulo }} }</b><span>{{ s.detalle }}</span>@if (s.salida !== 'siguiente') { <small>Salida: {{ s.salida }}</small> }</li>
              }
            </ol>
          }
        </div>
      </div>
    }

    @if (ej(); as x) {
      <div class="overlay" (click)="ej.set(null)">
        <div class="modal ancho" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <header class="m-cab"><h3>Ejecuciones: {{ x.nombre }}</h3><button type="button" class="btn ico" aria-label="Cerrar" (click)="ej.set(null)"><app-icon name="x" [size]="18" /></button></header>
          @for (e of ejecuciones(); track e.id) {
            <article class="exe" (click)="verRegistros(e)">
              <b>{{ e.nombre }}</b><small>{{ fecha(e.creado_en) }}</small>
              <span class="tag" [class.si]="e.estado === 'completada'" [class.aviso]="e.estado === 'error'">{{ estadoEj(e.estado) }}</span>
              @if (e.error) { <small class="rojo">{{ e.error }}</small> }
            </article>
            @if (abierta() === e.id) {
              <ul class="regs">
                @for (g of registros(); track $index) { <li><b>{{ tipoNodo(g.tipo) }}</b> {{ g.detalle }}@if (g.salida) { <small>→ {{ g.salida }}</small> }</li> }
              </ul>
            }
          } @empty { <p class="nota">Este flujo todavía no se ha ejecutado.</p> }
        </div>
      </div>
    }
  `,
  styles: [ESTILOS_ADMIN, `
    .fila-sb { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .modelos { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .modelos select { flex: 1; min-width: 240px; }
    .ancho2 { grid-column: 1 / -1; } textarea { width: 100%; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 12px; font: inherit; resize: vertical; }
    .flujo { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 12px 14px; margin-top: 10px; border: 1px solid var(--line); border-radius: 14px; background: #fff; }
    .f-t { display: flex; flex-direction: column; gap: 2px; min-width: 200px; flex: 1; } .f-t small { color: var(--muted); } .aviso-t { color: #b45309 !important; font-weight: 600; }
    .tag { padding: 2px 10px; border-radius: 999px; background: #e8edf8; color: #334155; font-size: .74rem; font-weight: 600; } .tag.si { background: #dcfce7; color: #047857; } .tag.aviso { background: #fef3c7; color: #b45309; }
    .modal.ancho { width: min(760px, 100%); max-height: 90vh; overflow-y: auto; } .m-cab { display: flex; justify-content: space-between; align-items: center; }
    .paso { display: flex; flex-direction: column; gap: 8px; padding: 12px; margin: 10px 0; border: 1px solid var(--line); border-radius: 12px; background: #fafbfe; }
    .pasos { margin: 12px 0 0; padding-left: 22px; display: flex; flex-direction: column; gap: 8px; } .pasos li { display: flex; flex-direction: column; gap: 2px; } .pasos small { color: var(--muted); }
    .exe { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px; margin-top: 8px; border: 1px solid var(--line); border-radius: 12px; cursor: pointer; } .exe small { color: var(--muted); } .rojo { color: #b91c1c !important; }
    .regs { margin: 4px 0 0 14px; padding-left: 18px; font-size: .86rem; color: #334155; } .regs small { color: var(--muted); }
    .chk { display: flex; flex-direction: row; align-items: center; gap: 8px; font-weight: 600; cursor: pointer; } .chk input { width: 17px; height: 17px; accent-color: var(--brand); }
  `],
})
export class CrmAutomatizacionesComponent implements OnInit {
  private readonly api: AutomatizacionesService = inject(AutomatizacionesService);
  private readonly arch: ArchivosService = inject(ArchivosService);
  readonly archivos = signal<ArchivoCrm[]>([]);
  readonly canales = CANALES;
  readonly unidades = UNIDADES;
  readonly camposDe = camposDe;

  readonly flujos = signal<FlujoResumen[]>([]);
  readonly plantillas = signal<PlantillaFlujo[]>([]);
  readonly cfgIa = signal<ConfigIa | null>(null);
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');
  readonly ocupado = signal<boolean>(false);

  // IA
  readonly fp = signal<string>('gemini');
  readonly fm = signal<string>('');
  readonly fk = signal<string>('');
  readonly fx = signal<string>('');
  readonly fd = signal<string>('200');
  readonly listaModelos = signal<{ id: string; recomendado: boolean }[]>([]);
  readonly urlClave = computed<string>(() => this.cfgIa()?.proveedores.find((p) => p.id === this.fp())?.url_clave ?? '');

  // Nuevo flujo
  readonly nuevo = signal<boolean>(false);
  readonly editorId = signal<number | null>(null);
  readonly nNombre = signal<string>('');
  readonly nCanal = signal<Canal>('whatsapp');
  readonly nPlantilla = signal<string>('bienvenida');
  readonly descPlantilla = computed<string>(() => this.plantillas().find((p) => p.id === this.nPlantilla())?.descripcion ?? '');

  // Edición de textos
  readonly ed = signal<Edicion | null>(null);
  readonly ordenados = computed<Nodo[]>(() => [...(this.ed()?.def.nodos ?? [])].sort((a, b) => a.x - b.x || a.y - b.y));

  // Prueba
  readonly pr = signal<FlujoResumen | null>(null);
  readonly pMensaje = signal<string>('Hola, ¿cuánto cuesta?');
  readonly pRespuesta = signal<string>('Sí, me interesa');
  readonly pSin = signal<boolean>(false);
  readonly resultado = signal<ResultadoPrueba | null>(null);

  // Ejecuciones
  readonly ej = signal<FlujoResumen | null>(null);
  readonly ejecuciones = signal<EjecucionFlujo[]>([]);
  readonly abierta = signal<number | null>(null);
  readonly registros = signal<RegistroFlujo[]>([]);

  ngOnInit(): void {
    this.cargar();
    this.api.plantillas().subscribe({ next: (p) => this.plantillas.set(p), error: (e: HttpErrorResponse) => this.fallo(e) });
    this.cargarArchivos();
    this.cargarIa();
  }

  private ok(t: string): void { this.error.set(''); this.mensaje.set(t); }
  private falla(t: string): void { this.mensaje.set(''); this.error.set(t); }
  private fallo(e: HttpErrorResponse): void {
    this.ocupado.set(false);
    const d = e.error?.detail;
    this.falla(typeof d === 'string' ? d : 'No se pudo conectar con el servidor');
  }

  canal(c: string): string { return CANALES.find((x) => x.id === c)?.label ?? c; }
  evento(e: string): string { return EVENTOS[e] ?? 'Sin inicio'; }
  tipoNodo(t: string): string { return NODOS[t] ?? t; }
  estadoEj(e: string): string { return ESTADOS[e] ?? e; }
  fecha(iso: string): string { return new Date(iso).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }); }

  cargar(): void { this.api.lista().subscribe({ next: (l) => this.flujos.set(l), error: (e: HttpErrorResponse) => this.fallo(e) }); }

// ---------------- Archivos para flujos ----------------
  tamano(n: number): string { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }

  cargarArchivos(): void { this.arch.lista().subscribe({ next: (l) => this.archivos.set(l), error: (e: HttpErrorResponse) => this.fallo(e) }); }

  subirArchivo(input: HTMLInputElement): void {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    if (f.size > 16 * 1024 * 1024) { this.falla('El archivo es demasiado grande (máximo 16 MB; imágenes 5 MB).'); return; }
    this.ocupado.set(true);
    this.arch.subir(f).subscribe({
      next: () => { this.ocupado.set(false); this.ok('Archivo subido'); this.cargarArchivos(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  verArchivo(a: ArchivoCrm): void {
    this.arch.contenido(a.id).subscribe({
      next: (b) => {
        const url = URL.createObjectURL(b);
        const x = document.createElement('a');
        x.href = url; x.download = a.nombre; x.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  borrarArchivo(a: ArchivoCrm): void {
    if (!confirm(`¿Eliminar «${a.nombre}» de la biblioteca?`)) return;
    this.arch.borrar(a.id).subscribe({ next: () => { this.ok('Archivo eliminado'); this.cargarArchivos(); }, error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  // ---------------- IA ----------------
  private cargarIa(): void {
    this.api.configIa().subscribe({
      next: (c) => { this.cfgIa.set(c); this.fp.set(c.proveedor); this.fm.set(c.modelo); this.fx.set(c.instrucciones); this.fd.set(String(c.max_dia)); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  cambiarProveedor(p: string): void {
    this.fp.set(p);
    this.listaModelos.set([]);
    this.fm.set(this.cfgIa()?.proveedores.find((x) => x.id === p)?.modelo ?? '');
  }

  guardarIa(): void {
    this.ocupado.set(true);
    this.api.guardarIa({ proveedor: this.fp(), modelo: this.fm().trim(), clave: this.fk().trim(), instrucciones: this.fx().trim(), max_dia: Number(this.fd()) || 200 }).subscribe({
      next: () => { this.ocupado.set(false); this.fk.set(''); this.ok('Configuración de IA guardada. Pulsa «Probar IA».'); this.cargarIa(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  verModelos(): void {
    this.ocupado.set(true);
    this.api.modelosIa(this.fp(), this.fk().trim()).subscribe({
      next: (r) => {
        this.ocupado.set(false);
        this.listaModelos.set(r.modelos);
        this.ok(`Tu clave puede usar ${r.modelos.length} modelos. Elige uno de la lista y pulsa «Guardar».`);
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  elegirModelo(id: string): void { if (id) this.fm.set(id); }

  probarIa(): void {
    this.ocupado.set(true);
    this.api.probarIa().subscribe({ next: (r) => { this.ocupado.set(false); this.ok(r.detalle); }, error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  // ---------------- Crear, publicar, pausar, borrar ----------------
  abrirNuevo(): void { this.nNombre.set(''); this.nPlantilla.set(this.plantillas()[0]?.id ?? ''); this.nuevo.set(true); }

  crear(): void {
    if (this.nNombre().trim().length < 2) { this.falla('Escribe un nombre para el flujo'); return; }
    this.ocupado.set(true);
    this.api.crear({ nombre: this.nNombre().trim(), canal: this.nCanal(), plantilla: this.nPlantilla() || null }).subscribe({
      next: (r) => { this.ocupado.set(false); this.nuevo.set(false); this.ok('Flujo creado como borrador.'); this.cargar(); this.editorId.set(r.id); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  publicar(f: FlujoResumen): void {
    if (!confirm(`¿Publicar «${f.nombre}»? Desde ahora responderá de verdad a tus clientes por ${this.canal(f.canal)}.`)) return;
    this.api.publicar(f.id).subscribe({ next: () => { this.ok('Flujo publicado'); this.cargar(); }, error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  pausar(f: FlujoResumen): void {
    if (!confirm(`¿Pausar «${f.nombre}»? Se cancelan las ejecuciones que estaban en curso o esperando.`)) return;
    this.api.pausar(f.id).subscribe({ next: () => { this.ok('Flujo pausado'); this.cargar(); }, error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  borrar(f: FlujoResumen): void {
    if (!confirm(`¿Eliminar «${f.nombre}» y su historial de ejecuciones?`)) return;
    this.api.borrar(f.id).subscribe({ next: () => { this.ok('Flujo eliminado'); this.cargar(); }, error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  // ---------------- Editar textos ----------------
  abrirEdicion(f: FlujoResumen): void {
    this.api.detalle(f.id).subscribe({
      next: (d) => this.ed.set({ id: d.id, nombre: d.nombre, canal: d.canal, canal_id: d.canal_id, def: d.definicion }),
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  nombreFlujo(v: string): void { this.ed.update((e) => (e ? { ...e, nombre: v } : e)); }
  leer(n: Nodo, k: CampoNodo): string {
    const v = n.config[k.k];
    if (Array.isArray(v)) return v.join(', ');
    return v === undefined || v === null ? '' : String(v);
  }

  poner(id: string, k: CampoNodo, valor: string): void {
    const v: unknown = k.t === 'numero' ? Number(valor) || 0 : k.t === 'palabras' ? valor.split(',').map((x) => x.trim()).filter(Boolean) : valor;
    this.ed.update((e) => (e ? { ...e, def: { ...e.def, nodos: e.def.nodos.map((n) => (n.id === id ? { ...n, config: { ...n.config, [k.k]: v } } : n)) } } : e));
  }

  guardarEdicion(): void {
    const e = this.ed();
    if (!e) return;
    this.ocupado.set(true);
    this.api.guardar(e.id, { nombre: e.nombre.trim(), canal: e.canal, canal_id: e.canal_id, definicion: e.def }).subscribe({
      next: () => { this.ocupado.set(false); this.ed.set(null); this.ok('Borrador guardado. Para que se aplique, pulsa «Publicar».'); this.cargar(); },
      error: (er: HttpErrorResponse) => this.fallo(er),
    });
  }

  // ---------------- Probar ----------------
  abrirPrueba(f: FlujoResumen): void { this.resultado.set(null); this.pr.set(f); }

  ejecutarPrueba(): void {
    const f = this.pr();
    if (!f) return;
    this.ocupado.set(true);
    this.api.probar(f.id, { mensaje: this.pMensaje(), respuesta: this.pRespuesta(), sin_respuesta: this.pSin() }).subscribe({
      next: (r) => { this.ocupado.set(false); this.resultado.set(r); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  // ---------------- Ejecuciones ----------------
  abrirEjecuciones(f: FlujoResumen): void {
    this.abierta.set(null);
    this.api.ejecuciones(f.id).subscribe({ next: (l) => { this.ejecuciones.set(l); this.ej.set(f); }, error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  verRegistros(e: EjecucionFlujo): void {
    if (this.abierta() === e.id) { this.abierta.set(null); return; }
    this.api.registros(e.id).subscribe({ next: (r) => { this.registros.set(r); this.abierta.set(e.id); }, error: (er: HttpErrorResponse) => this.fallo(er) });
  }
}