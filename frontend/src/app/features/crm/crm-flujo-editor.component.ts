import { ChangeDetectionStrategy, Component, ElementRef, OnInit, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable, of, switchMap, tap } from 'rxjs';
import { CrmService, Ejecutivo, Etapa } from './crm.service';
import { Canal, CanalCrm, Plantilla, WhatsappService } from './crm-whatsapp.service';
import { AutomatizacionesService, Conexion, Nodo, PasoPrueba, TipoNodo } from './crm-automatizaciones.service';
import { ArchivoCrm, ArchivosService } from './crm-archivos.service';

interface Instantanea { nodos: Nodo[]; conexiones: Conexion[]; }
interface Meta { nombre: string; icono: string; color: string; descripcion: string; }

const ANCHO = 230;
const META: Record<TipoNodo, Meta> = {
  disparador: { nombre: 'Inicio', icono: '⚡', color: '#e11d48', descripcion: 'Lo que activa el flujo' },
  mensaje: { nombre: 'Enviar mensaje', icono: '💬', color: '#2563eb', descripcion: 'Envía un texto al cliente' },
  plantilla: { nombre: 'Plantilla de WhatsApp', icono: '📋', color: '#0ea5e9', descripcion: 'Mensaje aprobado por Meta' },
  ia: { nombre: 'Responder con IA', icono: '🤖', color: '#7c3aed', descripcion: 'La IA contesta por ti' },
  archivo: { nombre: 'Enviar archivo', icono: '📎', color: '#0d9488', descripcion: 'Imagen, audio, video o documento' },
  botones: { nombre: 'Botones de WhatsApp', icono: '🔘', color: '#ea580c', descripcion: 'El cliente elige un botón' },
  esperar: { nombre: 'Esperar', icono: '⏱️', color: '#64748b', descripcion: 'Pausa durante un tiempo' },
  esperar_respuesta: { nombre: 'Esperar respuesta', icono: '↩️', color: '#0891b2', descripcion: 'Espera a que el cliente conteste' },
  condicion: { nombre: 'Condición', icono: '🔀', color: '#d97706', descripcion: 'Divide el camino según un dato' },
  asignar: { nombre: 'Asignar ejecutivo', icono: '👤', color: '#059669', descripcion: 'Pasa el lead a un ejecutivo' },
  etapa: { nombre: 'Cambiar etapa', icono: '🏷️', color: '#db2777', descripcion: 'Mueve el lead en el embudo' },
  nota: { nombre: 'Agregar nota', icono: '📝', color: '#a16207', descripcion: 'Deja una nota en el historial' },
  tarea: { nombre: 'Crear tarea', icono: '✅', color: '#16a34a', descripcion: 'Programa una tarea para el equipo' },
  fin: { nombre: 'Fin', icono: '⏹️', color: '#475569', descripcion: 'Termina el flujo' },
};
const PALETA: TipoNodo[] = ['mensaje', 'botones', 'archivo', 'plantilla', 'ia', 'esperar', 'esperar_respuesta', 'condicion', 'asignar', 'etapa', 'nota', 'tarea', 'fin'];
const SALIDAS: Record<TipoNodo, { id: string; label: string }[]> = {
  disparador: [{ id: 'siguiente', label: '' }],
  mensaje: [{ id: 'siguiente', label: 'Enviado' }, { id: 'error', label: 'Error' }],
  plantilla: [{ id: 'siguiente', label: 'Enviada' }, { id: 'error', label: 'Error' }],
  ia: [{ id: 'siguiente', label: 'Respondió' }, { id: 'humano', label: 'A una persona' }, { id: 'error', label: 'Error' }],
  archivo: [{ id: 'siguiente', label: 'Enviado' }, { id: 'error', label: 'Error' }],
  botones: [{ id: 'b1', label: 'Botón 1' }, { id: 'b2', label: 'Botón 2' }, { id: 'b3', label: 'Botón 3' }, { id: 'otro', label: 'Otra respuesta' }, { id: 'tiempo', label: 'Sin respuesta' }, { id: 'error', label: 'Error' }],
  esperar: [{ id: 'siguiente', label: '' }],
  esperar_respuesta: [{ id: 'respondio', label: 'Respondió' }, { id: 'tiempo', label: 'Sin respuesta' }],
  condicion: [{ id: 'si', label: 'Sí' }, { id: 'no', label: 'No' }],
  asignar: [{ id: 'siguiente', label: '' }], etapa: [{ id: 'siguiente', label: '' }],
  nota: [{ id: 'siguiente', label: '' }], tarea: [{ id: 'siguiente', label: '' }], fin: [],
};
const EVENTOS = [
  { id: 'mensaje_entrante', label: 'El cliente escribe un mensaje', ayuda: 'Se activa con cada mensaje, o solo con el primero de cada persona.' },
  { id: 'palabra_clave', label: 'El cliente escribe una palabra clave', ayuda: 'Por ejemplo: precio, horario, información.' },
  { id: 'lead_nuevo', label: 'Se crea un lead nuevo', ayuda: 'Se activa al crearse el lead, según su origen. Los leads importados nunca lo activan.' },
  { id: 'sin_respuesta', label: 'El cliente no responde', ayuda: 'Se activa cuando pasa el tiempo indicado desde el último mensaje enviado sin respuesta.' },
];
const ORIGENES = [
  { id: 'whatsapp', label: 'WhatsApp' }, { id: 'facebook', label: 'Facebook (Messenger y anuncios)' }, { id: 'instagram', label: 'Instagram' },
  { id: 'web', label: 'Formulario web' }, { id: 'cotizacion', label: 'Solicitud de cotización' }, { id: 'manual', label: 'Carga manual' },
];
const CAMPOS = [
  { id: 'mensaje', label: 'Último mensaje del cliente' }, { id: 'origen', label: 'Origen del lead' }, { id: 'canal', label: 'Canal' },
  { id: 'interes', label: 'Interés' }, { id: 'empresa', label: 'Empresa' }, { id: 'etapa', label: 'Etapa' },
  { id: 'ejecutivo', label: 'Ejecutivo asignado' }, { id: 'horario', label: 'Día y hora de atención' },
];
const OPERADORES = [
  { id: 'contiene', label: 'contiene' }, { id: 'no_contiene', label: 'no contiene' }, { id: 'igual', label: 'es igual a' },
  { id: 'distinto', label: 'es distinto de' }, { id: 'empieza', label: 'empieza con' }, { id: 'vacio', label: 'está vacío' }, { id: 'no_vacio', label: 'no está vacío' },
];
const UNIDADES = [{ id: 'minutos', label: 'minutos' }, { id: 'horas', label: 'horas' }, { id: 'dias', label: 'días' }];
const UNIDAD_SEG: Record<string, number> = { minutos: 60, horas: 3600, dias: 86400 };
const DIAS = [{ i: 0, l: 'L' }, { i: 1, l: 'M' }, { i: 2, l: 'X' }, { i: 3, l: 'J' }, { i: 4, l: 'V' }, { i: 5, l: 'S' }, { i: 6, l: 'D' }];
const VARIABLES = [
  { etiqueta: 'Nombre', token: '{{nombre}}' }, { etiqueta: 'Primer nombre', token: '{{primer_nombre}}' }, { etiqueta: 'Mensaje del cliente', token: '{{mensaje}}' },
  { etiqueta: 'Ejecutivo', token: '{{ejecutivo}}' }, { etiqueta: 'Teléfono', token: '{{telefono}}' }, { etiqueta: 'Interés', token: '{{interes}}' },
];
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const ORIGENES_DEFECTO = ['whatsapp', 'facebook', 'instagram'];

function salidasDe(n: Nodo): { id: string; label: string }[] {
  if (n.tipo !== 'botones') return SALIDAS[n.tipo];
  const bs = Array.isArray(n.config['botones']) ? (n.config['botones'] as unknown[]).slice(0, 3) : [];
  return [
    ...bs.map((b, i) => ({ id: `b${i + 1}`, label: String(b).trim() || `Botón ${i + 1}` })),
    { id: 'otro', label: 'Otra respuesta' }, { id: 'tiempo', label: 'Sin respuesta' }, { id: 'error', label: 'Error' },
  ];
}
function alto(n: Nodo): number { return Math.max(80, 30 + salidasDe(n).length * 34); }
function puertoY(n: Nodo, i: number): number { return (alto(n) / (salidasDe(n).length + 1)) * (i + 1); }
function curva(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(60, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}
function snap(v: number): number { return Math.round(v / 10) * 10; }
function corto(t: string, n = 70): string { const s = t.replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
function configInicial(t: TipoNodo): Record<string, unknown> {
  switch (t) {
    case 'mensaje': return { texto: '' };
    case 'plantilla': return { plantilla: '', idioma: '', variables: [] };
    case 'ia': return { instrucciones: '', pausa_horas: 24 };
    case 'archivo': return { archivo_id: 0, texto: '' };
    case 'botones': return { texto: '', botones: ['', ''], cantidad: 12, unidad: 'horas', archivo_id: 0 };
    case 'esperar': return { cantidad: 1, unidad: 'horas' };
    case 'esperar_respuesta': return { cantidad: 12, unidad: 'horas' };
    case 'condicion': return { campo: 'mensaje', operador: 'contiene', valor: '' };
    case 'asignar': return { ejecutivo_id: 'reparto', solo_sin_asignar: true };
    case 'etapa': return { etapa_id: 0 };
    case 'nota': return { texto: '' };
    case 'tarea': return { texto: '', horas: 2 };
    default: return {};
  }
}

@Component({
  selector: 'app-crm-flujo-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:keydown)': 'tecla($event)' },
  template: `
    <div class="ed">
      <header class="top">
        <button type="button" class="btn" (click)="salir()">← Volver</button>
        <input class="nombre" aria-label="Nombre del flujo" [value]="nombre()" (input)="setNombre($any($event.target).value)" />
        <span class="badge">{{ canalNombre() }}</span>
        <span class="badge" [class.pub]="estado() === 'publicado'">{{ estado() === 'publicado' ? (cambiosPend() ? 'Publicado (con cambios)' : 'Publicado') : 'Borrador' }}</span>
        @if (sucio()) { <span class="badge aviso">Sin guardar</span> }
        <span class="grow"></span>
        <button type="button" class="btn ico" title="Deshacer (Ctrl+Z)" [disabled]="nPasado() === 0" (click)="deshacer()">↶</button>
        <button type="button" class="btn ico" title="Rehacer (Ctrl+Y)" [disabled]="nFuturo() === 0" (click)="rehacer()">↷</button>
        <button type="button" class="btn ico" title="Alejar" (click)="zoom(-1)">−</button>
        <span class="zoom">{{ zoomPct() }}%</span>
        <button type="button" class="btn ico" title="Acercar" (click)="zoom(1)">+</button>
        <button type="button" class="btn" (click)="ajustar()">Ajustar</button>
        <button type="button" class="btn" (click)="ordenar()">Ordenar</button>
        <button type="button" class="btn" [class.on]="panelPrueba()" (click)="panelPrueba.set(!panelPrueba())">Probar</button>
        <button type="button" class="btn" [disabled]="ocupado()" (click)="guardar()">Guardar</button>
        <button type="button" class="btn primary" [disabled]="ocupado()" (click)="publicar()">{{ estado() === 'publicado' ? 'Publicar cambios' : 'Publicar' }}</button>
      </header>

      <div class="cuerpo">
        <aside class="paleta">
          <h4>Pasos</h4>
          <p class="nota">Arrástralos al lienzo o haz clic. Con un paso seleccionado, el nuevo se conecta solo.</p>
          @for (t of paleta(); track t.tipo) {
            <div class="item" draggable="true" (dragstart)="arrastrarPaleta($event, t.tipo)" (click)="agregar(t.tipo)">
              <span class="ico" [style.background]="t.color">{{ t.icono }}</span>
              <div><b>{{ t.nombre }}</b><small>{{ t.descripcion }}</small></div>
            </div>
          }
        </aside>

        <div class="centro">
          <div #lienzo class="lienzo" [style.background-position]="vista().x + 'px ' + vista().y + 'px'"
               [style.background-size]="(24 * vista().z) + 'px ' + (24 * vista().z) + 'px'"
               (pointerdown)="lienzoDown($event)" (pointermove)="mover($event)" (pointerup)="soltar($event)" (pointercancel)="soltar($event)"
               (wheel)="rueda($event)" (dragover)="$event.preventDefault()" (drop)="soltarPaleta($event)">
            <div class="mundo" [style.transform]="transformar()">
              <svg class="cables" width="1" height="1">
                @for (c of cables(); track c.key) {
                  <g>
                    <path class="cable-hit" [attr.d]="c.d" (pointerdown)="$event.stopPropagation()" (click)="elegirCable(c.key)" />
                    <path class="cable" [class.sel]="c.sel" [class.activo]="c.activo" [attr.d]="c.d" />
                  </g>
                }
                @if (cableTemp()) { <path class="cable temp" [attr.d]="cableTemp()" /> }
                @if (cableSel(); as c) {
                  <g class="quitar" (pointerdown)="$event.stopPropagation()" (click)="quitarCable(c.key)">
                    <circle [attr.cx]="c.mx" [attr.cy]="c.my" r="11" />
                    <text [attr.x]="c.mx" [attr.y]="c.my + 4" text-anchor="middle">✕</text>
                  </g>
                }
              </svg>
              @for (n of nodos(); track n.id) {
                <div class="nodo" [class.sel]="sel() === n.id" [class.malo]="problemas().has(n.id)" [class.paso]="orden(n.id) > 0"
                     [style.left.px]="n.x" [style.top.px]="n.y" [style.height.px]="alto(n)" [style.--c]="meta(n).color"
                     (pointerdown)="empezarNodo($event, n)">
                  <div class="n-cab"><span class="n-ico">{{ meta(n).icono }}</span><b>{{ titulo(n) }}</b></div>
                  <p class="n-res">{{ resumen(n) }}</p>
                  @if (orden(n.id) > 0) { <span class="orden">{{ orden(n.id) }}</span> }
                  @if (problemas().get(n.id); as p) { <span class="alerta" [title]="p">!</span> }
                  @if (n.tipo !== 'disparador') { <span class="puerto ent"></span> }
                  @for (s of salidas(n); track s.id; let i = $index) {
                    @if (s.label) { <span class="etq" [style.top.px]="puertoY(n, i) - 9">{{ s.label }}</span> }
                    <span class="puerto sal" [class.libre]="!conectada(n.id, s.id)" [style.top.px]="puertoY(n, i)" (pointerdown)="empezarCable($event, n, s.id)"></span>
                  }
                </div>
              }
            </div>
            @if (!cargado()) { <div class="cargando">Cargando…</div> }
          </div>

          @if (mensaje()) { <div class="toast ok">{{ mensaje() }}</div> }
          @if (error()) { <div class="toast mal">{{ error() }}</div> }

          @if (panelPrueba()) {
            <div class="prueba">
              <div class="p-fila">
                <b>Probar el flujo</b>
                <label>El cliente escribe <input [value]="pMensaje()" (input)="pMensaje.set($any($event.target).value)" /></label>
                <label>Si el flujo espera, contesta <input [value]="pRespuesta()" (input)="pRespuesta.set($any($event.target).value)" /></label>
                <label class="chk"><input type="checkbox" [checked]="pSin()" (change)="pSin.set($any($event.target).checked)" /> No responde a tiempo</label>
                <button type="button" class="btn primary" [disabled]="ocupado()" (click)="ejecutarPrueba()">Ejecutar prueba</button>
                @if (traza().length) { <button type="button" class="btn" (click)="traza.set([])">Limpiar</button> }
              </div>
              <small class="nota">No envía nada ni llama a la IA. Guarda el borrador y muestra el camino sobre el lienzo.</small>
              @if (motivoPrueba()) { <p class="aviso-p">{{ motivoPrueba() }}</p> }
              @if (traza().length) {
                <ol class="traza">
                  @for (p of traza(); track $index) { <li (click)="irA(p.nodo)"><b>{{ nombreTipo(p.tipo) }}</b> {{ p.detalle }}@if (p.salida !== 'siguiente') { <small> → {{ p.salida }}</small> }</li> }
                </ol>
              }
            </div>
          }
        </div>

        <aside class="panel" (focusout)="finEdicion()">
          @if (nodoSel(); as n) {
            <div class="p-cab"><span class="ico" [style.background]="meta(n).color">{{ meta(n).icono }}</span><div><b>{{ meta(n).nombre }}</b><small>{{ meta(n).descripcion }}</small></div></div>
            @if (problemas().get(n.id); as p) { <p class="aviso-p">{{ p }}</p> }
            <label>Nombre del paso (opcional)<input maxlength="40" [value]="v(n, 'rotulo')" (input)="cfg('rotulo', $any($event.target).value)" /></label>

            @switch (n.tipo) {
              @case ('disparador') {
                <label>Se activa cuando
                  <select (change)="cfg('evento', $any($event.target).value)">
                    <option value="" [selected]="!v(n, 'evento')">Elige…</option>
                    @for (e of eventos; track e.id) { <option [value]="e.id" [selected]="v(n, 'evento') === e.id">{{ e.label }}</option> }
                  </select>
                </label>
                @if (ayudaEvento(n); as a) { <small class="nota">{{ a }}</small> }
                @if (v(n, 'evento') === 'palabra_clave') {
                  <label>Palabras clave (separadas por coma)<input [value]="lista(n, 'palabras')" (input)="cfgLista('palabras', $any($event.target).value)" /></label>
                  <label>Coincidencia
                    <select (change)="cfg('modo', $any($event.target).value)">
                      <option value="contiene" [selected]="v(n, 'modo') !== 'igual'">El mensaje contiene la palabra</option>
                      <option value="igual" [selected]="v(n, 'modo') === 'igual'">El mensaje es exactamente la palabra</option>
                    </select>
                  </label>
                }
                @if (v(n, 'evento') === 'mensaje_entrante') {
                  <label class="chk"><input type="checkbox" [checked]="b(n, 'solo_primero')" (change)="cfg('solo_primero', $any($event.target).checked)" /> Solo el primer mensaje de cada persona</label>
                }
                @if (v(n, 'evento') === 'sin_respuesta') {
                  <label>Minutos sin respuesta (mínimo 5)<input type="number" min="5" [value]="v(n, 'minutos')" (input)="cfgNum('minutos', $any($event.target).value)" /></label>
                }
                @if (v(n, 'evento') === 'lead_nuevo') {
                  <small>Origen del lead</small>
                  @for (o of origenes; track o.id) {
                    <label class="chk"><input type="checkbox" [checked]="origenActivo(n, o.id)" (change)="alternarOrigen(n, o.id, $any($event.target).checked)" /> {{ o.label }}</label>
                  }
                }
                <label>No repetir con la misma persona antes de (horas; 0 = siempre)
                  <input type="number" min="0" [value]="v(n, 'repetir_horas')" (input)="cfgNum('repetir_horas', $any($event.target).value)" />
                </label>
              }
              @case ('mensaje') {
                <label>Mensaje<textarea rows="6" maxlength="1500" [value]="v(n, 'texto')" (input)="cfg('texto', $any($event.target).value)"></textarea></label>
                <div class="vars"><small>Insertar:</small>@for (x of variables; track x.token) { <button type="button" class="chip" (click)="insertar(n, 'texto', x.token)">{{ x.etiqueta }}</button> }</div>
                <small class="nota">{{ v(n, 'texto').length }}/1500. Solo se envía dentro de las 24 horas del último mensaje del cliente; si no, sale por «Error».</small>
              }
              @case ('plantilla') {
                @if (plantillasWa() === null) { <small class="nota">Cargando plantillas aprobadas…</small> }
                @else if (!plantillasWa()!.length) { <small class="nota">No hay plantillas aprobadas. Créalas en el Administrador de WhatsApp de Meta.</small> }
                @else {
                  <label>Plantilla aprobada
                    <select (change)="elegirPlantilla($any($event.target).value)">
                      <option value="" [selected]="!v(n, 'plantilla')">Elige…</option>
                      @for (p of plantillasWa(); track p.nombre + p.idioma) { <option [value]="p.nombre + '|' + p.idioma" [selected]="v(n, 'plantilla') === p.nombre && v(n, 'idioma') === p.idioma">{{ p.nombre }} ({{ p.idioma }})</option> }
                    </select>
                  </label>
                  @if (plantillaSel(n); as p) {
                    <div class="vista">{{ p.cuerpo }}</div>
                    @for (x of variablesDe(n); track $index; let i = $index) {
                      <label>Variable {{ i + 1 }}<input [value]="x" (input)="cfgVariable(n, i, $any($event.target).value)" /></label>
                    }
                  }
                }
              }
              @case ('archivo') {
                <label>Archivo de la biblioteca
                  <select (change)="cfgNum('archivo_id', $any($event.target).value)">
                    <option value="0" [selected]="!n.config['archivo_id']">Elige…</option>
                    @for (a of archivosLib(); track a.id) { <option [value]="a.id" [selected]="v(n, 'archivo_id') === '' + a.id">{{ a.nombre }} ({{ a.categoria }})</option> }
                  </select>
                </label>
                @if (!archivosLib().length) { <small class="nota">Aún no hay archivos. Súbelos en CRM → Automatizaciones → Archivos para flujos.</small> }
                <label>Texto que acompaña (opcional; no aplica a audios)<textarea rows="3" maxlength="1000" [value]="v(n, 'texto')" (input)="cfg('texto', $any($event.target).value)"></textarea></label>
                <div class="vars"><small>Insertar:</small>@for (x of variables; track x.token) { <button type="button" class="chip" (click)="insertar(n, 'texto', x.token)">{{ x.etiqueta }}</button> }</div>
                <small class="nota">Se envía dentro de las 24 horas del último mensaje del cliente. En Instagram, Meta puede rechazar documentos.</small>
              }
              @case ('botones') {
                <label>Mensaje<textarea rows="4" maxlength="1024" [value]="v(n, 'texto')" (input)="cfg('texto', $any($event.target).value)"></textarea></label>
                <small>Botones (de 1 a 3, hasta 20 caracteres)</small>
                @for (bt of botonesDe(n); track $index; let i = $index) {
                  <div class="fila-b">
                    <input maxlength="20" [value]="bt" (input)="cfgBoton(n, i, $any($event.target).value)" />
                    <button type="button" class="btn ico" title="Quitar botón" [disabled]="botonesDe(n).length <= 1" (click)="quitarBoton(n, i)">✕</button>
                  </div>
                }
                @if (botonesDe(n).length < 3) { <button type="button" class="btn" (click)="agregarBoton(n)">+ Agregar botón</button> }
                <label>Imagen o video arriba del mensaje (opcional)
                  <select (change)="cfgNum('archivo_id', $any($event.target).value)">
                    <option value="0" [selected]="!n.config['archivo_id']">Sin archivo</option>
                    @for (a of archivosVisuales(); track a.id) { <option [value]="a.id" [selected]="v(n, 'archivo_id') === '' + a.id">{{ a.nombre }}</option> }
                  </select>
                </label>
                <div class="dos">
                  <label>Esperar hasta<input type="number" min="1" [value]="v(n, 'cantidad')" (input)="cfgNum('cantidad', $any($event.target).value)" /></label>
                  <label>Unidad<select (change)="cfg('unidad', $any($event.target).value)">@for (u of unidades; track u.id) { <option [value]="u.id" [selected]="v(n, 'unidad') === u.id">{{ u.label }}</option> }</select></label>
                </div>
                <small class="nota">Cada botón tiene su salida en el lienzo. «Otra respuesta» sale si el cliente escribe otra cosa y «Sin respuesta» si pasa el tiempo. Solo funciona dentro de las 24 horas del último mensaje del cliente.</small>
              }
              @case ('ia') {
                <label>Instrucciones para esta conversación<textarea rows="7" maxlength="1500" [value]="v(n, 'instrucciones')" (input)="cfg('instrucciones', $any($event.target).value)"></textarea></label>
                <label>Si pasa a una persona, la IA calla (horas)<input type="number" min="1" [value]="v(n, 'pausa_horas')" (input)="cfgNum('pausa_horas', $any($event.target).value)" /></label>
                <small class="nota">La IA usa la información de tu empresa configurada en Automatizaciones. Cuando el cliente pide una persona o se molesta, sale por «A una persona».</small>
              }
              @case ('esperar') {
                <div class="dos">
                  <label>Esperar<input type="number" min="1" [value]="v(n, 'cantidad')" (input)="cfgNum('cantidad', $any($event.target).value)" /></label>
                  <label>Unidad<select (change)="cfg('unidad', $any($event.target).value)">@for (u of unidades; track u.id) { <option [value]="u.id" [selected]="v(n, 'unidad') === u.id">{{ u.label }}</option> }</select></label>
                </div>
                <small class="nota">Máximo 30 días. Si una persona escribe al cliente mientras tanto, la espera se cancela.</small>
              }
              @case ('esperar_respuesta') {
                <div class="dos">
                  <label>Esperar hasta<input type="number" min="1" [value]="v(n, 'cantidad')" (input)="cfgNum('cantidad', $any($event.target).value)" /></label>
                  <label>Unidad<select (change)="cfg('unidad', $any($event.target).value)">@for (u of unidades; track u.id) { <option [value]="u.id" [selected]="v(n, 'unidad') === u.id">{{ u.label }}</option> }</select></label>
                </div>
                <small class="nota">Si el cliente responde, sigue por «Respondió». Si pasa el tiempo, por «Sin respuesta». Máximo 7 días.</small>
              }
              @case ('condicion') {
                <label>Dato a revisar
                  <select (change)="cambiarCampo($any($event.target).value)">@for (c of campos; track c.id) { <option [value]="c.id" [selected]="v(n, 'campo') === c.id">{{ c.label }}</option> }</select>
                </label>
                @if (v(n, 'campo') === 'horario') {
                  <label>Se cumple cuando es
                    <select (change)="cfg('operador', $any($event.target).value)">
                      <option value="dentro" [selected]="v(n, 'operador') === 'dentro'">Dentro del horario</option>
                      <option value="fuera" [selected]="v(n, 'operador') !== 'dentro'">Fuera del horario</option>
                    </select>
                  </label>
                  <div class="dos">
                    <label>Desde<input type="time" [value]="v(n, 'desde')" (input)="cfg('desde', $any($event.target).value)" /></label>
                    <label>Hasta<input type="time" [value]="v(n, 'hasta')" (input)="cfg('hasta', $any($event.target).value)" /></label>
                  </div>
                  <div class="dias">@for (d of dias; track d.i) { <label class="dia" [class.on]="diaActivo(n, d.i)"><input type="checkbox" [checked]="diaActivo(n, d.i)" (change)="alternarDia(n, d.i, $any($event.target).checked)" />{{ d.l }}</label> }</div>
                } @else {
                  <label>Condición
                    <select (change)="cfg('operador', $any($event.target).value)">@for (o of operadores; track o.id) { <option [value]="o.id" [selected]="v(n, 'operador') === o.id">{{ o.label }}</option> }</select>
                  </label>
                  @if (v(n, 'operador') !== 'vacio' && v(n, 'operador') !== 'no_vacio') {
                    <label>Valor<input [value]="v(n, 'valor')" (input)="cfg('valor', $any($event.target).value)" /></label>
                  }
                }
                <small class="nota">«Sí» sigue si se cumple; «No» si no se cumple.</small>
              }
              @case ('asignar') {
                <label>Asignar a
                  <select (change)="cfgEjecutivo($any($event.target).value)">
                    <option value="reparto" [selected]="v(n, 'ejecutivo_id') === 'reparto'">Reparto rotativo</option>
                    @for (e of ejecutivos(); track e.id) { <option [value]="e.id" [selected]="v(n, 'ejecutivo_id') === '' + e.id">{{ e.nombre }}</option> }
                  </select>
                </label>
                <label class="chk"><input type="checkbox" [checked]="b(n, 'solo_sin_asignar', true)" (change)="cfg('solo_sin_asignar', $any($event.target).checked)" /> Solo si el lead todavía no tiene ejecutivo</label>
                <small class="nota">El reparto rotativo solo asigna si está en «Rotativo» en CRM → Configuración.</small>
              }
              @case ('etapa') {
                <label>Mover a la etapa
                  <select (change)="cfgNum('etapa_id', $any($event.target).value)">
                    <option value="0" [selected]="!n.config['etapa_id']">Elige…</option>
                    @for (e of etapas(); track e.id) { <option [value]="e.id" [selected]="v(n, 'etapa_id') === '' + e.id">{{ e.nombre }}</option> }
                  </select>
                </label>
              }
              @case ('nota') {
                <label>Texto de la nota<textarea rows="4" [value]="v(n, 'texto')" (input)="cfg('texto', $any($event.target).value)"></textarea></label>
                <div class="vars"><small>Insertar:</small>@for (x of variables; track x.token) { <button type="button" class="chip" (click)="insertar(n, 'texto', x.token)">{{ x.etiqueta }}</button> }</div>
              }
              @case ('tarea') {
                <label>Texto de la tarea<textarea rows="4" [value]="v(n, 'texto')" (input)="cfg('texto', $any($event.target).value)"></textarea></label>
                <div class="vars"><small>Insertar:</small>@for (x of variables; track x.token) { <button type="button" class="chip" (click)="insertar(n, 'texto', x.token)">{{ x.etiqueta }}</button> }</div>
                <label>Vence en (horas)<input type="number" min="0" max="720" [value]="v(n, 'horas')" (input)="cfgNum('horas', $any($event.target).value)" /></label>
              }
              @case ('fin') { <small class="nota">Aquí termina el flujo. También termina si un paso no tiene conexión.</small> }
            }
            @if (n.tipo !== 'disparador') { <button type="button" class="btn peligro" (click)="borrarNodo(n.id)">Eliminar paso</button> }
          } @else {
            <div class="p-cab"><b>Ajustes del flujo</b></div>
            <label>Nombre<input [value]="nombre()" (input)="setNombre($any($event.target).value)" /></label>
            <p class="nota">Canal: <b>{{ canalNombre() }}</b></p>
            <label>Número o cuenta
              <select (change)="setCanalId($any($event.target).value)">
                <option value="" [selected]="canalId() === null">Todos los de {{ canalNombre() }}</option>
                @for (c of canalesDelTipo(); track c.id) { <option [value]="c.id" [selected]="canalId() === c.id">{{ c.nombre }}</option> }
              </select>
            </label>
            <h4>Revisión</h4>
            @if (avisos().length) {
              <ul class="avisos">@for (a of avisos(); track $index) { <li (click)="irA(a.id)">{{ a.texto }}</li> }</ul>
            } @else { <p class="ok-p">Todo listo para publicar.</p> }
            <h4>Cómo se usa</h4>
            <ul class="tips">
              <li>Para conectar, arrastra desde el círculo de la derecha de un paso hasta otro paso.</li>
              <li>Para quitar una conexión, haz clic en la línea y luego en la ✕ (o pulsa Supr).</li>
              <li>Arrastra el fondo para moverte y usa la rueda para acercar o alejar.</li>
              <li>Una salida solo puede ir a un paso y el flujo no puede volver atrás.</li>
              <li>Pulsa «Probar» para ver el camino antes de publicar.</li>
            </ul>
          }
        </aside>
      </div>
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 120; display: block; font-family: 'Inter', system-ui, sans-serif; color: #0f172a; }
    * { box-sizing: border-box; }
    .ed { position: absolute; inset: 0; display: flex; flex-direction: column; background: #eef1f8; }
    .top { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: #fff; border-bottom: 1px solid #e2e8f4; flex-wrap: wrap; }
    .grow { flex: 1; } .nombre { width: min(300px, 30vw); height: 36px; padding: 0 12px; border: 1px solid #cbd5e1; border-radius: 10px; font: inherit; font-weight: 700; }
    .badge { padding: 3px 10px; border-radius: 999px; background: #e8edf8; color: #334155; font-size: .74rem; font-weight: 700; } .badge.pub { background: #dcfce7; color: #047857; } .badge.aviso { background: #fef3c7; color: #b45309; }
    .zoom { min-width: 44px; text-align: center; font-size: .8rem; color: #64748b; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 36px; padding: 0 14px; border: 1px solid #dbe2f0; border-radius: 10px; background: #fff; color: #0f172a; font: inherit; font-size: .84rem; font-weight: 600; cursor: pointer; }
    .btn:hover:not(:disabled) { background: #f4f7ff; } .btn:disabled { opacity: .45; cursor: not-allowed; } .btn.ico { width: 36px; padding: 0; font-size: 1.05rem; } .btn.on { background: #eef2ff; border-color: #a5b4fc; color: #4338ca; }
    .btn.primary { color: #fff; border-color: transparent; background: linear-gradient(135deg, #1d4ed8, #2f6bff); } .btn.peligro { color: #b91c1c; margin-top: 8px; }
    .cuerpo { flex: 1; min-height: 0; display: grid; grid-template-columns: 230px 1fr 340px; }
    .paleta, .panel { overflow-y: auto; padding: 14px; background: #fff; display: flex; flex-direction: column; gap: 10px; } .paleta { border-right: 1px solid #e2e8f4; } .panel { border-left: 1px solid #e2e8f4; }
    h4 { margin: 6px 0 0; font-size: .9rem; } .nota { margin: 0; color: #64748b; font-size: .8rem; line-height: 1.4; }
    .item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid #e2e8f4; border-radius: 12px; cursor: grab; background: #fff; } .item:hover { border-color: #93a8e6; background: #f8faff; }
    .item div { display: flex; flex-direction: column; min-width: 0; } .item small, .p-cab small { color: #64748b; font-size: .74rem; }
    .ico { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; color: #fff; font-size: 1rem; flex: none; }
    .centro { position: relative; min-width: 0; min-height: 0; }
    .lienzo { position: absolute; inset: 0; overflow: hidden; touch-action: none; cursor: grab; background-color: #f4f6fc; background-image: radial-gradient(circle, #c3ccdf 1.3px, transparent 1.5px); }
    .lienzo:active { cursor: grabbing; } .mundo { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
    .cables { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
    .cable { fill: none; stroke: #8aa0d4; stroke-width: 2.5; pointer-events: none; } .cable.sel { stroke: #2563eb; stroke-width: 3.5; } .cable.activo { stroke: #16a34a; stroke-width: 4; stroke-dasharray: 8 6; animation: fluir .8s linear infinite; }
    .cable.temp { stroke: #2563eb; stroke-dasharray: 6 5; } .cable-hit { fill: none; stroke: transparent; stroke-width: 16; pointer-events: stroke; cursor: pointer; }
    .quitar { cursor: pointer; pointer-events: all; } .quitar circle { fill: #ef4444; stroke: #fff; stroke-width: 2; } .quitar text { fill: #fff; font-size: 12px; font-weight: 700; }
    @keyframes fluir { to { stroke-dashoffset: -28; } }
    .nodo { position: absolute; width: 230px; padding: 8px 12px; background: #fff; border: 2px solid #dfe5f3; border-left: 6px solid var(--c); border-radius: 14px; box-shadow: 0 4px 14px rgb(15 23 42 / .08); cursor: move; user-select: none; }
    .nodo.sel { border-color: var(--c); box-shadow: 0 0 0 4px rgb(37 99 235 / .15), 0 6px 18px rgb(15 23 42 / .14); } .nodo.malo { border-top-color: #fca5a5; border-right-color: #fca5a5; border-bottom-color: #fca5a5; } .nodo.paso { background: #f0fdf4; }
    .n-cab { display: flex; align-items: center; gap: 7px; font-size: .86rem; } .n-cab b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .n-res { margin: 4px 0 0; color: #64748b; font-size: .76rem; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .orden { position: absolute; left: -14px; top: -14px; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: #16a34a; color: #fff; font-size: .75rem; font-weight: 700; }
    .alerta { position: absolute; right: -8px; top: -8px; display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: #ef4444; color: #fff; font-size: .75rem; font-weight: 800; }
    .puerto { position: absolute; width: 16px; height: 16px; margin-top: -8px; border-radius: 50%; background: #fff; border: 3px solid #6b82c4; } .puerto.ent { left: -11px; top: 50%; } .puerto.sal { right: -11px; cursor: crosshair; } .puerto.sal.libre { border-color: #2563eb; background: #dbeafe; }
    .puerto.sal:hover { background: #2563eb; transform: scale(1.2); } .etq { position: absolute; right: 14px; font-size: .68rem; font-weight: 700; color: #64748b; line-height: 18px; }
    .cargando { position: absolute; inset: 0; display: grid; place-items: center; background: rgb(244 246 252 / .8); color: #64748b; }
    .toast { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); padding: 9px 16px; border-radius: 10px; font-size: .86rem; font-weight: 600; box-shadow: 0 8px 24px rgb(15 23 42 / .18); } .toast.ok { background: #065f46; color: #fff; } .toast.mal { background: #991b1b; color: #fff; max-width: 80%; }
    .prueba { position: absolute; left: 12px; right: 12px; bottom: 12px; max-height: 45%; overflow-y: auto; padding: 12px 14px; background: #fff; border: 1px solid #dbe2f0; border-radius: 14px; box-shadow: 0 12px 32px rgb(15 23 42 / .2); display: flex; flex-direction: column; gap: 8px; }
    .p-fila { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; } .p-fila label { flex: 1; min-width: 160px; }
    .traza { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 5px; font-size: .84rem; } .traza li { cursor: pointer; } .traza li:hover { color: #1d4ed8; } .traza small { color: #64748b; }
    label { display: flex; flex-direction: column; gap: 5px; font-size: .8rem; font-weight: 600; color: #1e293b; }
    input, select, textarea { padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 9px; font: inherit; font-weight: 400; background: #fff; width: 100%; } textarea { resize: vertical; } input[type='checkbox'] { width: 16px; height: 16px; padding: 0; accent-color: #2563eb; }
    input:focus, select:focus, textarea:focus { outline: 0; border-color: #2563eb; box-shadow: 0 0 0 3px rgb(37 99 235 / .15); }
    .chk { flex-direction: row; align-items: center; gap: 8px; font-weight: 500; cursor: pointer; } .dos { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .p-cab { display: flex; align-items: center; gap: 10px; } .p-cab div { display: flex; flex-direction: column; }
    .fila-b { display: flex; gap: 6px; align-items: center; }
    .vars { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; } .chip { padding: 3px 10px; border: 1px solid #dbe2f0; border-radius: 999px; background: #f8faff; font: inherit; font-size: .74rem; cursor: pointer; } .chip:hover { background: #eef2ff; }
    .vista { padding: 10px 12px; border-radius: 10px; background: #f0f4ff; font-size: .82rem; white-space: pre-wrap; }
    .dias { display: flex; gap: 6px; } .dia { flex-direction: row; justify-content: center; width: 34px; height: 34px; align-items: center; border: 1px solid #cbd5e1; border-radius: 9px; cursor: pointer; } .dia.on { background: #2563eb; border-color: #2563eb; color: #fff; } .dia input { display: none; }
    .aviso-p { margin: 0; padding: 8px 10px; border-radius: 9px; background: #fef2f2; color: #b91c1c; font-size: .8rem; font-weight: 600; } .ok-p { margin: 0; padding: 8px 10px; border-radius: 9px; background: #ecfdf5; color: #047857; font-size: .82rem; font-weight: 600; }
    .avisos, .tips { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; font-size: .8rem; } .avisos li { cursor: pointer; color: #b91c1c; } .tips { color: #475569; }
    @media (max-width: 1000px) { .cuerpo { grid-template-columns: 180px 1fr 280px; } }
  `],
})
export class CrmFlujoEditorComponent implements OnInit {
  private readonly api: AutomatizacionesService = inject(AutomatizacionesService);
  private readonly crm: CrmService = inject(CrmService);
  private readonly ws: WhatsappService = inject(WhatsappService);
  private readonly arch: ArchivosService = inject(ArchivosService);
  readonly flujoId = input.required<number>();
  readonly cerrar = output<void>();
  readonly cambio = output<void>();
  private readonly lienzo = viewChild<ElementRef<HTMLElement>>('lienzo');

  readonly eventos = EVENTOS; readonly origenes = ORIGENES; readonly campos = CAMPOS; readonly operadores = OPERADORES;
  readonly unidades = UNIDADES; readonly dias = DIAS; readonly variables = VARIABLES;
  readonly alto = alto; readonly puertoY = puertoY;

  readonly nombre = signal<string>('');
  readonly canal = signal<Canal>('whatsapp');
  readonly canalId = signal<number | null>(null);
  readonly estado = signal<string>('borrador');
  readonly nodos = signal<Nodo[]>([]);
  readonly conexiones = signal<Conexion[]>([]);
  readonly sel = signal<string | null>(null);
  readonly selCable = signal<string | null>(null);
  readonly vista = signal<{ x: number; y: number; z: number }>({ x: 40, y: 40, z: 1 });
  readonly sucio = signal<boolean>(false);
  readonly cambiosPend = signal<boolean>(false);
  readonly cargado = signal<boolean>(false);
  readonly ocupado = signal<boolean>(false);
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');
  readonly conectando = signal<{ de: string; salida: string } | null>(null);
  readonly raton = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  readonly panelPrueba = signal<boolean>(false);
  readonly pMensaje = signal<string>('Hola, ¿cuánto cuesta?');
  readonly pRespuesta = signal<string>('Sí, me interesa');
  readonly pSin = signal<boolean>(false);
  readonly traza = signal<PasoPrueba[]>([]);
  readonly motivoPrueba = signal<string>('');
  readonly etapas = signal<Etapa[]>([]);
  readonly ejecutivos = signal<Ejecutivo[]>([]);
  readonly canalesDisp = signal<CanalCrm[]>([]);
  readonly plantillasWa = signal<Plantilla[] | null>(null);
  readonly archivosLib = signal<ArchivoCrm[]>([]);
  readonly archivosVisuales = computed<ArchivoCrm[]>(() => this.archivosLib().filter((a) => a.categoria === 'imagen' || a.categoria === 'video'));
  readonly nPasado = signal<number>(0);
  readonly nFuturo = signal<number>(0);

  private pasado: Instantanea[] = [];
  private futuro: Instantanea[] = [];
  private mov: { id: string; dx: number; dy: number; movido: boolean } | null = null;
  private pan: { sx: number; sy: number; vx: number; vy: number } | null = null;
  private snapEdicion = false;

  readonly paleta = computed(() => PALETA.filter((t) => (t !== 'plantilla' && t !== 'botones') || this.canal() === 'whatsapp').map((t) => ({ tipo: t, ...META[t] })));
  readonly nodoSel = computed<Nodo | null>(() => this.nodos().find((n) => n.id === this.sel()) ?? null);
  readonly canalNombre = computed<string>(() => ({ whatsapp: 'WhatsApp', facebook: 'Messenger', instagram: 'Instagram' })[this.canal()]);
  readonly canalesDelTipo = computed<CanalCrm[]>(() => this.canalesDisp().filter((c) => c.tipo === this.canal() && c.estado !== 'desconectado'));
  readonly zoomPct = computed<number>(() => Math.round(this.vista().z * 100));
  readonly transformar = computed<string>(() => `translate(${this.vista().x}px, ${this.vista().y}px) scale(${this.vista().z})`);

  readonly alcanzables = computed<Set<string>>(() => {
    const ini = this.nodos().find((n) => n.tipo === 'disparador');
    const vistos = new Set<string>();
    if (!ini) return vistos;
    const pila = [ini.id];
    vistos.add(ini.id);
    while (pila.length) {
      const u = pila.pop() as string;
      for (const c of this.conexiones()) if (c.de === u && !vistos.has(c.a)) { vistos.add(c.a); pila.push(c.a); }
    }
    return vistos;
  });

  readonly problemas = computed<Map<string, string>>(() => {
    const m = new Map<string, string>();
    const alc = this.alcanzables();
    for (const n of this.nodos()) {
      const p = this.configInvalida(n);
      if (p) m.set(n.id, p);
      else if (!alc.has(n.id)) m.set(n.id, 'No está conectado al inicio del flujo');
    }
    return m;
  });

  readonly avisos = computed<{ id: string; texto: string }[]>(() => {
    const out: { id: string; texto: string }[] = [];
    if (!this.nodos().some((n) => n.tipo === 'disparador')) out.push({ id: '', texto: 'Falta el paso de inicio.' });
    else if (this.nodos().length > 1 && this.conexiones().length === 0) out.push({ id: '', texto: 'Conecta el inicio con otros pasos.' });
    for (const n of this.nodos()) {
      const p = this.problemas().get(n.id);
      if (p) out.push({ id: n.id, texto: `${this.titulo(n)}: ${p}` });
    }
    return out;
  });

  private readonly recorridos = computed<Set<string>>(() => new Set(this.traza().map((p) => `${p.nodo}|${p.salida}`)));

  readonly cables = computed(() => {
    const ns = new Map(this.nodos().map((n) => [n.id, n]));
    const rec = this.recorridos();
    return this.conexiones().flatMap((c) => {
      const a = ns.get(c.de);
      const b = ns.get(c.a);
      if (!a || !b) return [];
      const i = salidasDe(a).findIndex((s) => s.id === c.salida);
      if (i < 0) return [];
      const x1 = a.x + ANCHO, y1 = a.y + puertoY(a, i), x2 = b.x, y2 = b.y + alto(b) / 2;
      const key = `${c.de}|${c.salida}`;
      return [{ key, d: curva(x1, y1, x2, y2), sel: this.selCable() === key, activo: rec.has(key), mx: (x1 + x2) / 2, my: (y1 + y2) / 2 }];
    });
  });
  readonly cableSel = computed(() => this.cables().find((c) => c.sel) ?? null);

  readonly cableTemp = computed<string>(() => {
    const c = this.conectando();
    const a = c ? this.nodos().find((n) => n.id === c.de) : null;
    if (!c || !a) return '';
    const r = this.raton();
    return curva(a.x + ANCHO, a.y + puertoY(a, salidasDe(a).findIndex((s) => s.id === c.salida)), r.x, r.y);
  });

  ngOnInit(): void {
    this.api.detalle(this.flujoId()).subscribe({
      next: (d) => {
        this.nombre.set(d.nombre); this.canal.set(d.canal); this.canalId.set(d.canal_id); this.estado.set(d.estado);
        this.nodos.set(d.definicion.nodos.map((n) => ({ ...n, config: n.config ?? {} })));
        this.conexiones.set(d.definicion.conexiones);
        this.cargado.set(true);
        setTimeout(() => this.ajustar());
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
    this.crm.etapas().subscribe({ next: (l) => this.etapas.set(l.filter((e) => e.activa)), error: () => undefined });
    this.crm.ejecutivos().subscribe({ next: (l) => this.ejecutivos.set(l.filter((e) => e.activo)), error: () => undefined });
    this.ws.canales().subscribe({ next: (r) => this.canalesDisp.set(r.canales), error: () => undefined });
    this.arch.lista().subscribe({ next: (l) => this.archivosLib.set(l), error: () => undefined });
  }

  // ---------------- Utilidades de presentación ----------------
  meta(n: Nodo): Meta { return META[n.tipo]; }
  nombreTipo(t: string): string { return META[t as TipoNodo]?.nombre ?? t; }
  titulo(n: Nodo): string { return String(n.config['rotulo'] || META[n.tipo].nombre); }
  salidas(n: Nodo): { id: string; label: string }[] { return salidasDe(n); }
  conectada(id: string, salida: string): boolean { return this.conexiones().some((c) => c.de === id && c.salida === salida); }
  orden(id: string): number { return this.traza().findIndex((p) => p.nodo === id) + 1; }
  v(n: Nodo, k: string): string { const x = n.config[k]; return x === undefined || x === null ? '' : String(x); }
  b(n: Nodo, k: string, def = false): boolean { const x = n.config[k]; return x === undefined ? def : x === true; }
  lista(n: Nodo, k: string): string { const x = n.config[k]; return Array.isArray(x) ? x.join(', ') : ''; }
  ayudaEvento(n: Nodo): string { return EVENTOS.find((e) => e.id === this.v(n, 'evento'))?.ayuda ?? ''; }
  variablesDe(n: Nodo): string[] { const x = n.config['variables']; return Array.isArray(x) ? x.map(String) : []; }
  plantillaSel(n: Nodo): Plantilla | null { return (this.plantillasWa() ?? []).find((p) => p.nombre === this.v(n, 'plantilla') && p.idioma === this.v(n, 'idioma')) ?? null; }
  origenActivo(n: Nodo, id: string): boolean { return this.origenesDe(n).includes(id); }
  diaActivo(n: Nodo, i: number): boolean { return this.diasDe(n).includes(i); }
  private origenesDe(n: Nodo): string[] { const x = n.config['origenes']; return Array.isArray(x) ? x.map(String) : ORIGENES_DEFECTO; }
  private diasDe(n: Nodo): number[] { const x = n.config['dias']; return Array.isArray(x) ? x.map(Number) : [0, 1, 2, 3, 4, 5, 6]; }

  resumen(n: Nodo): string {
    const c = n.config;
    const s = (k: string): string => String(c[k] ?? '');
    switch (n.tipo) {
      case 'disparador': {
        const e = s('evento');
        if (e === 'palabra_clave') return `Palabra clave: ${this.lista(n, 'palabras') || '…'}`;
        if (e === 'sin_respuesta') return `Sin respuesta en ${s('minutos') || '?'} min`;
        return EVENTOS.find((x) => x.id === e)?.label ?? 'Elige qué activa el flujo';
      }
      case 'mensaje': return corto(s('texto')) || 'Escribe el mensaje';
      case 'plantilla': return s('plantilla') || 'Elige una plantilla';
      case 'ia': return corto(s('instrucciones')) || 'Responde con tu información de empresa';
      case 'archivo': return this.archivosLib().find((a) => a.id === Number(c['archivo_id']))?.nombre ?? 'Elige un archivo';
      case 'botones': return corto(s('texto')) || 'Escribe el mensaje y los botones';
      case 'esperar': case 'esperar_respuesta': return `${s('cantidad') || '?'} ${UNIDADES.find((u) => u.id === s('unidad'))?.label ?? ''}`;
      case 'condicion':
        if (s('campo') === 'horario') return `${s('operador') === 'dentro' ? 'Dentro' : 'Fuera'} de ${s('desde')} a ${s('hasta')}`;
        return `${CAMPOS.find((x) => x.id === s('campo'))?.label ?? ''} ${OPERADORES.find((x) => x.id === s('operador'))?.label ?? ''} ${s('valor')}`.trim();
      case 'asignar': return c['ejecutivo_id'] === 'reparto' ? 'Reparto rotativo' : (this.ejecutivos().find((e) => e.id === Number(c['ejecutivo_id']))?.nombre ?? 'Elige un ejecutivo');
      case 'etapa': return this.etapas().find((e) => e.id === Number(c['etapa_id']))?.nombre ?? 'Elige una etapa';
      case 'nota': case 'tarea': return corto(s('texto')) || 'Escribe el texto';
      default: return META[n.tipo].descripcion;
    }
  }

  private configInvalida(n: Nodo): string {
    const c = n.config;
    const t = (k: string): string => String(c[k] ?? '').trim();
    const num = (k: string): number => Number(c[k]) || 0;
    switch (n.tipo) {
      case 'disparador': {
        const e = t('evento');
        if (!EVENTOS.some((x) => x.id === e)) return 'Elige qué activa el flujo';
        if (e === 'palabra_clave' && !(Array.isArray(c['palabras']) && (c['palabras'] as unknown[]).some((p) => String(p).trim()))) return 'Escribe al menos una palabra clave';
        if (e === 'sin_respuesta' && (num('minutos') < 5 || num('minutos') > 10080)) return 'Los minutos van de 5 a 10080';
        return '';
      }
      case 'mensaje': return t('texto') ? '' : 'Escribe el mensaje';
      case 'plantilla': return t('plantilla') && t('idioma') ? '' : 'Elige una plantilla';
      case 'archivo': return num('archivo_id') > 0 ? '' : 'Elige un archivo de la biblioteca';
      case 'botones': {
        const bs = Array.isArray(c['botones']) ? (c['botones'] as unknown[]).map((x) => String(x).trim()) : [];
        if (!t('texto')) return 'Escribe el mensaje';
        if (bs.length < 1 || bs.length > 3 || bs.some((x) => !x || x.length > 20)) return 'Escribe de 1 a 3 botones (hasta 20 caracteres)';
        if (new Set(bs.map((x) => x.toLowerCase())).size !== bs.length) return 'Los botones deben ser distintos';
        const seg = num('cantidad') * (UNIDAD_SEG[t('unidad')] ?? 0);
        return seg >= 60 && seg <= 7 * 86400 ? '' : 'El tiempo debe ir de 1 minuto a 7 días';
      }
      case 'esperar': case 'esperar_respuesta': {
        const seg = num('cantidad') * (UNIDAD_SEG[t('unidad')] ?? 0);
        const max = n.tipo === 'esperar' ? 30 * 86400 : 7 * 86400;
        return seg >= 60 && seg <= max ? '' : `El tiempo debe ir de 1 minuto a ${n.tipo === 'esperar' ? 30 : 7} días`;
      }
      case 'condicion':
        if (!CAMPOS.some((x) => x.id === t('campo'))) return 'Elige el dato a revisar';
        if (t('campo') === 'horario') return (t('operador') === 'dentro' || t('operador') === 'fuera') && HORA.test(t('desde')) && HORA.test(t('hasta')) ? '' : 'Indica el horario (desde y hasta)';
        if (!OPERADORES.some((x) => x.id === t('operador'))) return 'Elige la condición';
        return t('operador') === 'vacio' || t('operador') === 'no_vacio' || t('valor') ? '' : 'Escribe el valor a comparar';
      case 'asignar': return c['ejecutivo_id'] === 'reparto' || num('ejecutivo_id') > 0 ? '' : 'Elige un ejecutivo o el reparto';
      case 'etapa': return num('etapa_id') > 0 ? '' : 'Elige una etapa';
      case 'nota': return t('texto') ? '' : 'Escribe la nota';
      case 'tarea': return t('texto') && c['horas'] !== undefined && num('horas') >= 0 && num('horas') <= 720 ? '' : 'Escribe la tarea (vence entre 0 y 720 horas)';
      case 'ia': return t('instrucciones').length <= 1500 ? '' : 'Las instrucciones son demasiado largas';
      default: return '';
    }
  }

  // ---------------- Mensajes ----------------
  private ok(t: string): void { this.error.set(''); this.mensaje.set(t); setTimeout(() => { if (this.mensaje() === t) this.mensaje.set(''); }, 3000); }
  private avisoTemp(t: string): void { this.mensaje.set(''); this.error.set(t); setTimeout(() => { if (this.error() === t) this.error.set(''); }, 4000); }
  private fallo(e: HttpErrorResponse): void {
    this.ocupado.set(false);
    const d = e.error?.detail;
    this.error.set(typeof d === 'string' ? d : 'No se pudo conectar con el servidor');
  }

  // ---------------- Historial ----------------
  private guardarHistorial(): void {
    this.pasado.push({ nodos: this.nodos(), conexiones: this.conexiones() });
    if (this.pasado.length > 60) this.pasado.shift();
    this.futuro = [];
    this.nPasado.set(this.pasado.length);
    this.nFuturo.set(0);
  }

  private tocar(): void {
    this.sucio.set(true);
    this.cambiosPend.set(true);
    if (this.traza().length) this.traza.set([]);
  }

  deshacer(): void {
    const s = this.pasado.pop();
    if (!s) return;
    this.futuro.push({ nodos: this.nodos(), conexiones: this.conexiones() });
    this.nodos.set(s.nodos); this.conexiones.set(s.conexiones);
    this.nPasado.set(this.pasado.length); this.nFuturo.set(this.futuro.length);
    this.sel.set(null); this.selCable.set(null); this.tocar();
  }

  rehacer(): void {
    const s = this.futuro.pop();
    if (!s) return;
    this.pasado.push({ nodos: this.nodos(), conexiones: this.conexiones() });
    this.nodos.set(s.nodos); this.conexiones.set(s.conexiones);
    this.nPasado.set(this.pasado.length); this.nFuturo.set(this.futuro.length);
    this.sel.set(null); this.selCable.set(null); this.tocar();
  }

  // ---------------- Lienzo: ratón ----------------
  private el(): HTMLElement | null { return this.lienzo()?.nativeElement ?? null; }

  private mundo(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.el()?.getBoundingClientRect();
    const v = this.vista();
    return r ? { x: (e.clientX - r.left - v.x) / v.z, y: (e.clientY - r.top - v.y) / v.z } : { x: 0, y: 0 };
  }

  private nodoEn(p: { x: number; y: number }): Nodo | null {
    return this.nodos().find((n) => p.x >= n.x && p.x <= n.x + ANCHO && p.y >= n.y && p.y <= n.y + alto(n)) ?? null;
  }

  lienzoDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.sel.set(null); this.selCable.set(null);
    const v = this.vista();
    this.pan = { sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y };
    this.el()?.setPointerCapture(e.pointerId);
  }

  empezarNodo(e: PointerEvent, n: Nodo): void {
    e.stopPropagation();
    if (e.button !== 0) return;
    this.seleccionar(n.id);
    this.guardarHistorial();
    const p = this.mundo(e);
    this.mov = { id: n.id, dx: p.x - n.x, dy: p.y - n.y, movido: false };
    this.el()?.setPointerCapture(e.pointerId);
  }

  empezarCable(e: PointerEvent, n: Nodo, salida: string): void {
    e.stopPropagation();
    if (e.button !== 0) return;
    this.conectando.set({ de: n.id, salida });
    this.raton.set(this.mundo(e));
    this.el()?.setPointerCapture(e.pointerId);
  }

  mover(e: PointerEvent): void {
    if (this.mov) {
      const m = this.mov;
      const p = this.mundo(e);
      const x = snap(p.x - m.dx), y = snap(p.y - m.dy);
      const actual = this.nodos().find((n) => n.id === m.id);
      if (actual && (actual.x !== x || actual.y !== y)) {
        m.movido = true;
        this.nodos.update((l) => l.map((n) => (n.id === m.id ? { ...n, x, y } : n)));
        this.tocar();
      }
    } else if (this.conectando()) {
      this.raton.set(this.mundo(e));
    } else if (this.pan) {
      const p = this.pan;
      this.vista.update((v) => ({ ...v, x: p.vx + (e.clientX - p.sx), y: p.vy + (e.clientY - p.sy) }));
    }
  }

  soltar(e: PointerEvent): void {
    const el = this.el();
    if (el && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (this.mov) {
      if (!this.mov.movido) { this.pasado.pop(); this.nPasado.set(this.pasado.length); }
      this.mov = null;
    }
    const c = this.conectando();
    if (c) {
      const dest = this.nodoEn(this.mundo(e));
      if (dest) this.conectar(c.de, c.salida, dest.id);
      this.conectando.set(null);
    }
    this.pan = null;
  }

  rueda(e: WheelEvent): void {
    e.preventDefault();
    const r = this.el()?.getBoundingClientRect();
    if (r) this.zoomEn(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
  }

  private zoomEn(factor: number, cx: number, cy: number): void {
    this.vista.update((v) => {
      const z = Math.min(1.8, Math.max(0.3, v.z * factor));
      const k = z / v.z;
      return { x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, z };
    });
  }

  zoom(dir: number): void {
    const r = this.el()?.getBoundingClientRect();
    if (r) this.zoomEn(dir > 0 ? 1.15 : 1 / 1.15, r.width / 2, r.height / 2);
  }

  ajustar(): void {
    const r = this.el()?.getBoundingClientRect();
    const ns = this.nodos();
    if (!r || !ns.length) return;
    const x0 = Math.min(...ns.map((n) => n.x)), y0 = Math.min(...ns.map((n) => n.y));
    const x1 = Math.max(...ns.map((n) => n.x + ANCHO)), y1 = Math.max(...ns.map((n) => n.y + alto(n)));
    const z = Math.min(1, Math.max(0.3, Math.min((r.width - 100) / (x1 - x0), (r.height - 100) / (y1 - y0))));
    this.vista.set({ x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z, z });
  }

  ordenar(): void {
    const ns = this.nodos(), cs = this.conexiones();
    const ini = ns.find((n) => n.tipo === 'disparador');
    if (!ini) return;
    const prof = new Map<string, number>();
    const visitar = (id: string, d: number): void => {
      if (d > 60 || (prof.get(id) ?? -1) >= d) return;
      prof.set(id, d);
      for (const c of cs) if (c.de === id) visitar(c.a, d + 1);
    };
    visitar(ini.id, 0);
    const extra = Math.max(0, ...prof.values()) + 1;
    const filas = new Map<number, number>();
    const nuevos = ns.map((n) => {
      const d = prof.get(n.id) ?? extra;
      const f = filas.get(d) ?? 0;
      filas.set(d, f + 1);
      return { ...n, x: 40 + d * 300, y: 60 + f * 170 };
    });
    this.guardarHistorial();
    this.nodos.set(nuevos);
    this.tocar();
    setTimeout(() => this.ajustar());
  }

  // ---------------- Pasos y conexiones ----------------
  private nuevoId(): string {
    const max = Math.max(0, ...this.nodos().map((n) => Number(/^n(\d+)$/.exec(n.id)?.[1] ?? 0)));
    return `n${max + 1}`;
  }

  arrastrarPaleta(e: DragEvent, tipo: TipoNodo): void {
    if (e.dataTransfer) { e.dataTransfer.setData('text/plain', tipo); e.dataTransfer.effectAllowed = 'copy'; }
  }

  soltarPaleta(e: DragEvent): void {
    e.preventDefault();
    const t = e.dataTransfer?.getData('text/plain') as TipoNodo | undefined;
    if (t && PALETA.includes(t)) this.agregar(t, this.mundo(e));
  }

  agregar(tipo: TipoNodo, pos?: { x: number; y: number }): void {
    if (this.nodos().length >= 60) { this.avisoTemp('Máximo 60 pasos por flujo'); return; }
    const base = this.nodoSel();
    let x: number, y: number;
    if (pos) { x = pos.x - ANCHO / 2; y = pos.y - 30; }
    else if (base) { x = base.x + ANCHO + 80; y = base.y; }
    else {
      const r = this.el()?.getBoundingClientRect();
      const v = this.vista();
      x = ((r?.width ?? 600) / 2 - v.x) / v.z - ANCHO / 2; y = ((r?.height ?? 400) / 2 - v.y) / v.z - 40;
    }
    const nuevo: Nodo = { id: this.nuevoId(), tipo, x: snap(x), y: snap(y), config: configInicial(tipo) };
    this.guardarHistorial();
    this.nodos.update((l) => [...l, nuevo]);
    if (!pos && base) {
      const libre = salidasDe(base).find((s) => !this.conectada(base.id, s.id));
      if (libre) this.conexiones.update((l) => [...l, { de: base.id, salida: libre.id, a: nuevo.id }]);
    }
    this.tocar();
    this.seleccionar(nuevo.id);
  }

  seleccionar(id: string): void {
    this.sel.set(id);
    this.selCable.set(null);
    const n = this.nodos().find((x) => x.id === id);
    if (n?.tipo === 'plantilla' && this.plantillasWa() === null) {
      this.ws.plantillas().subscribe({
        next: (p) => this.plantillasWa.set(p),
        error: (e: HttpErrorResponse) => { this.plantillasWa.set([]); this.fallo(e); },
      });
    }
  }

  irA(id: string): void {
    const n = this.nodos().find((x) => x.id === id);
    if (!n) return;
    this.seleccionar(id);
    const r = this.el()?.getBoundingClientRect();
    if (r) this.vista.update((v) => ({ ...v, x: r.width / 2 - (n.x + ANCHO / 2) * v.z, y: r.height / 2 - (n.y + alto(n) / 2) * v.z }));
  }

  borrarNodo(id: string): void {
    const n = this.nodos().find((x) => x.id === id);
    if (!n) return;
    if (n.tipo === 'disparador') { this.avisoTemp('El paso de inicio no se puede eliminar'); return; }
    this.guardarHistorial();
    this.nodos.update((l) => l.filter((x) => x.id !== id));
    this.conexiones.update((l) => l.filter((c) => c.de !== id && c.a !== id));
    this.sel.set(null);
    this.tocar();
  }

  elegirCable(key: string): void { this.selCable.set(key); this.sel.set(null); }

  quitarCable(key: string): void {
    this.guardarHistorial();
    this.conexiones.update((l) => l.filter((c) => `${c.de}|${c.salida}` !== key));
    this.selCable.set(null);
    this.tocar();
  }

  private creaCiclo(de: string, a: string): boolean {
    const vistos = new Set<string>();
    const pila = [a];
    while (pila.length) {
      const u = pila.pop() as string;
      if (u === de) return true;
      if (vistos.has(u)) continue;
      vistos.add(u);
      for (const c of this.conexiones()) if (c.de === u) pila.push(c.a);
    }
    return false;
  }

  private conectar(de: string, salida: string, a: string): void {
    if (de === a) return;
    const dest = this.nodos().find((n) => n.id === a);
    if (!dest || dest.tipo === 'disparador') { this.avisoTemp('El inicio no puede recibir conexiones'); return; }
    if (this.creaCiclo(de, a)) { this.avisoTemp('Eso crearía un ciclo: por ahora los flujos deben avanzar sin volver atrás'); return; }
    this.guardarHistorial();
    this.conexiones.update((l) => [...l.filter((c) => !(c.de === de && c.salida === salida)), { de, salida, a }]);
    this.tocar();
  }

  // ---------------- Configuración del paso ----------------
  private snapshotEdicion(): void {
    if (!this.snapEdicion) { this.guardarHistorial(); this.snapEdicion = true; }
  }

  finEdicion(): void { this.snapEdicion = false; }

  cfgVarios(parcial: Record<string, unknown>): void {
    const id = this.sel();
    if (!id) return;
    this.snapshotEdicion();
    this.nodos.update((l) => l.map((n) => (n.id === id ? { ...n, config: { ...n.config, ...parcial } } : n)));
    this.tocar();
  }

  cfg(clave: string, valor: unknown): void { this.cfgVarios({ [clave]: valor }); }
  cfgNum(clave: string, valor: string): void { this.cfg(clave, Number(valor) || 0); }
  cfgLista(clave: string, valor: string): void { this.cfg(clave, valor.split(',').map((x) => x.trim()).filter(Boolean)); }
  insertar(n: Nodo, clave: string, token: string): void { this.cfg(clave, this.v(n, clave) + token); }
  cfgEjecutivo(valor: string): void { this.cfg('ejecutivo_id', valor === 'reparto' ? 'reparto' : Number(valor)); }
  botonesDe(n: Nodo): string[] { const x = n.config['botones']; return Array.isArray(x) ? x.map(String) : []; }
  cfgBoton(n: Nodo, i: number, valor: string): void { this.cfg('botones', this.botonesDe(n).map((x, j) => (j === i ? valor : x))); }
  agregarBoton(n: Nodo): void { if (this.botonesDe(n).length < 3) this.cfg('botones', [...this.botonesDe(n), '']); }

  quitarBoton(n: Nodo, i: number): void {
    if (this.botonesDe(n).length <= 1) return;
    this.guardarHistorial();
    const nuevos = this.botonesDe(n).filter((_, j) => j !== i);
    this.nodos.update((l) => l.map((x) => (x.id === n.id ? { ...x, config: { ...x.config, botones: nuevos } } : x)));
    this.conexiones.update((l) => l.flatMap((c) => {  // la salida del botón quitado se borra y las siguientes se corren una posición
      const m = c.de === n.id ? /^b(\d)$/.exec(c.salida) : null;
      if (!m) return [c];
      const k = Number(m[1]) - 1;
      if (k === i) return [];
      return [k > i ? { ...c, salida: `b${k}` } : c];
    }));
    this.tocar();
  }

  cfgVariable(n: Nodo, i: number, valor: string): void { this.cfg('variables', this.variablesDe(n).map((x, j) => (j === i ? valor : x))); }

  cambiarCampo(campo: string): void {
    this.cfgVarios(campo === 'horario'
      ? { campo, operador: 'fuera', desde: '09:00', hasta: '18:00', dias: [0, 1, 2, 3, 4], valor: '' }
      : { campo, operador: 'contiene', valor: '' });
  }

  alternarDia(n: Nodo, i: number, on: boolean): void {
    this.cfg('dias', on ? [...new Set([...this.diasDe(n), i])].sort() : this.diasDe(n).filter((d) => d !== i));
  }

  alternarOrigen(n: Nodo, id: string, on: boolean): void {
    this.cfg('origenes', on ? [...new Set([...this.origenesDe(n), id])] : this.origenesDe(n).filter((o) => o !== id));
  }

  elegirPlantilla(valor: string): void {
    const [nombre, idioma] = valor.split('|');
    const p = (this.plantillasWa() ?? []).find((x) => x.nombre === nombre && x.idioma === idioma);
    this.cfgVarios({ plantilla: p?.nombre ?? '', idioma: p?.idioma ?? '', variables: p ? Array.from({ length: p.variables }, () => '') : [] });
  }

  setNombre(v: string): void { this.nombre.set(v); this.sucio.set(true); }
  setCanalId(v: string): void { this.canalId.set(v ? Number(v) : null); this.sucio.set(true); this.cambiosPend.set(true); }

  // ---------------- Guardar, probar y publicar ----------------
  private guardado$(): Observable<unknown> {
    if (!this.sucio()) return of(null);
    return this.api.guardar(this.flujoId(), {
      nombre: this.nombre().trim(), canal: this.canal(), canal_id: this.canalId(),
      definicion: { nodos: this.nodos(), conexiones: this.conexiones() },
    }).pipe(tap(() => { this.sucio.set(false); this.cambio.emit(); }));
  }

  guardar(): void {
    this.ocupado.set(true);
    this.guardado$().subscribe({ next: () => { this.ocupado.set(false); this.ok('Borrador guardado'); }, error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  publicar(): void {
    if (this.avisos().length) { this.avisoTemp('Revisa los pasos marcados con ! antes de publicar'); return; }
    if (!confirm(`¿Publicar «${this.nombre()}»? Desde ahora responderá de verdad a tus clientes por ${this.canalNombre()}.`)) return;
    this.ocupado.set(true);
    this.guardado$().pipe(switchMap(() => this.api.publicar(this.flujoId()))).subscribe({
      next: () => { this.ocupado.set(false); this.estado.set('publicado'); this.cambiosPend.set(false); this.ok('Flujo publicado'); this.cambio.emit(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  ejecutarPrueba(): void {
    this.ocupado.set(true);
    this.error.set('');
    this.guardado$().pipe(switchMap(() => this.api.probar(this.flujoId(), { mensaje: this.pMensaje(), respuesta: this.pRespuesta(), sin_respuesta: this.pSin() }))).subscribe({
      next: (r) => { this.ocupado.set(false); this.traza.set(r.pasos); this.motivoPrueba.set(r.coincide ? '' : r.motivo); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  salir(): void {
    if (this.sucio() && !confirm('Tienes cambios sin guardar. ¿Salir sin guardarlos?')) return;
    this.cerrar.emit();
  }

  tecla(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    const escribiendo = !!t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (ctrl && k === 's') { e.preventDefault(); this.guardar(); return; }
    if (escribiendo) return;
    if (ctrl && k === 'z') { e.preventDefault(); if (e.shiftKey) this.rehacer(); else this.deshacer(); return; }
    if (ctrl && k === 'y') { e.preventDefault(); this.rehacer(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const c = this.selCable(), n = this.sel();
      if (c) this.quitarCable(c); else if (n) this.borrarNodo(n);
    }
    if (e.key === 'Escape') { this.conectando.set(null); this.sel.set(null); this.selCable.set(null); }
  }
}