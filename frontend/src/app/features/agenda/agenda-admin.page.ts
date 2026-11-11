import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { TiempoRealService } from '../../core/tiempo-real.service';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import { IconComponent } from '../../shared/icon.component';
import {
  AgendaAdminService, Asesor, Bloqueo, Entregable, EstadoEntregable, EstadoServicio, EstadoSesion, Horario,
  ModuloServicios, PedidoDetalle, PedidoSeg, PlataformaCita, Reglas, ServicioAgenda, SesionFila, Slot,
} from './agenda-admin.service';
import { CalendarioSesionesComponent } from './calendario-sesiones.component';
import { IntegracionesComponent } from './integraciones.component';

type Pestana = 'seguimiento' | 'calendario' | 'asesores' | 'servicios' | 'integraciones';
type Filtro = 'todos' | 'nuevo' | 'en_curso' | 'entregado' | 'agendar';
interface Agendar { sesionId: number | null; fecha: string; slots: Slot[]; cargando: boolean; }
interface EdAsesor {
  id: number | null; nombre: string; correo: string; plataforma: PlataformaCita; enlace: string; color: string;
  activo: boolean; bloqueos: Bloqueo[]; modoEnlace: 'fijo' | 'api'; zoomUsuario: string; usuarioId: number | null;
}
interface ServEdit { id: number; categoria: string; nombre: string; sesiones: number; dur: number; asesorIds: number[]; orig: string; }

const ZONA = 'America/Lima';
const DIAS = [
  { i: 0, n: 'Lunes' }, { i: 1, n: 'Martes' }, { i: 2, n: 'Miércoles' }, { i: 3, n: 'Jueves' },
  { i: 4, n: 'Viernes' }, { i: 5, n: 'Sábado' }, { i: 6, n: 'Domingo' },
];
const FILTROS: { id: Filtro; label: string }[] = [
  { id: 'todos', label: 'Todos' }, { id: 'agendar', label: 'Falta agendar' }, { id: 'nuevo', label: 'Sin iniciar' },
  { id: 'en_curso', label: 'En curso' }, { id: 'entregado', label: 'Completados' },
];
const ESTADO_SERVICIO: Record<string, string> = {
  nuevo: 'Sin iniciar', en_curso: 'En curso', entregado: 'Completado', cancelado: 'Cancelado',
};
const ESTADO_SESION: Record<string, string> = {
  programada: 'Programada', realizada: 'Realizada', no_asistio: 'No asistió', cancelada: 'Cancelada',
};
const PLATAFORMA: Record<string, string> = { meet: 'Google Meet', zoom: 'Zoom', otra: 'Otra plataforma' };

@Component({
  selector: 'app-agenda-admin',
  imports: [IconComponent, CalendarioSesionesComponent, IntegracionesComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <header class="cab">
        <div>
          <span class="eyebrow">Operación</span>
          <h2>Agenda y seguimiento</h2>
          <p class="sub">Controla qué se ha entregado a cada cliente, agenda sesiones con tus asesores y confirma las que ya se atendieron.</p>
        </div>
      </header>

      @if (mensaje()) { <p class="ok"><app-icon name="circle-check" [size]="18" /> {{ mensaje() }}</p> }
      @if (error()) { <p class="error"><app-icon name="alert" [size]="18" /> {{ error() }}</p> }

      <div class="tabs">
        <button type="button" [class.on]="pestana() === 'seguimiento'" (click)="irA('seguimiento')">
          <app-icon name="receipt" [size]="16" /> Seguimiento
          @if (cuenta('agendar') > 0) { <span class="num">{{ cuenta('agendar') }}</span> }
        </button>
        <button type="button" [class.on]="pestana() === 'calendario'" (click)="irA('calendario')"><app-icon name="calendar" [size]="16" /> Calendario</button>
        <button type="button" [class.on]="pestana() === 'asesores'" (click)="irA('asesores')"><app-icon name="users" [size]="16" /> Asesores</button>
        <button type="button" [class.on]="pestana() === 'servicios'" (click)="irA('servicios')"><app-icon name="layers" [size]="16" /> Servicios y reglas</button>
        <button type="button" [class.on]="pestana() === 'integraciones'" (click)="irA('integraciones')"><app-icon name="video" [size]="16" /> Integraciones</button>
      </div>

      <!-- ================= SEGUIMIENTO ================= -->
      @if (pestana() === 'seguimiento') {
        <div class="chips">
          @for (f of filtros; track f.id) {
            <button type="button" class="chip" [class.on]="filtro() === f.id" (click)="filtro.set(f.id)">{{ f.label }} ({{ cuenta(f.id) }})</button>
          }
        </div>
        <div class="tabla-wrap">
          <table class="tabla">
            <thead><tr><th>Cliente</th><th>Servicio</th><th>Avance</th><th>Sesiones</th><th>Estado</th><th></th></tr></thead>
            <tbody>
              @for (p of visibles(); track p.id) {
                <tr>
                  <td><b>{{ p.nombre }}</b><small>{{ p.empresa ?? p.correo }}</small></td>
                  <td>{{ p.servicio_nombre }}</td>
                  <td class="avance">
                    <div class="barra"><span [style.width.%]="p.progreso"></span></div>
                    <small>{{ p.hechos }}/{{ p.total_e }} entregables · {{ p.progreso }}%</small>
                  </td>
                  <td>
                    @if (p.sesiones_incluidas > 0) {
                      <b>{{ p.realizadas }}/{{ p.sesiones_incluidas }}</b> realizadas
                      @if (p.proxima) { <small>Próxima: {{ fechaHora(p.proxima) }}</small> }
                      @else if (faltaAgendar(p)) { <small class="alerta">Falta agendar</small> }
                    } @else { <small>Sin sesiones</small> }
                  </td>
                  <td><span class="estado" [class.ok]="p.estado === 'entregado'" [class.azul]="p.estado === 'en_curso'" [class.bad]="p.estado === 'cancelado'">{{ estadoServicio(p.estado) }}</span></td>
                  <td class="btns"><button type="button" class="btn primary" (click)="abrir(p.id)">Gestionar</button></td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="vacio">No hay servicios en esta vista.</td></tr>
              }
            </tbody>
          </table>
        </div>
      }

      <!-- ================= CALENDARIO ================= -->
      @if (pestana() === 'calendario') {
        <app-calendario-sesiones [asesores]="asesores()" (abrirPedido)="abrir($event)" />
      }

      <!-- ================= ASESORES ================= -->
      @if (pestana() === 'asesores') {
        <div class="barra-sup">
          <p class="nota">Tus asesores atienden las sesiones. Cada uno tiene su horario semanal y el enlace fijo de su sala de Meet o Zoom.</p>
          <button type="button" class="btn primary" (click)="nuevoAsesor()"><app-icon name="plus" [size]="16" /> Nuevo asesor</button>
        </div>
        <div class="ases">
          @for (a of asesores(); track a.id) {
            <article class="ase" [class.off]="!a.activo">
              <span class="av" [style.background]="a.color">{{ iniciales(a.nombre) }}</span>
              <div class="ase-t">
                <h3>{{ a.nombre }}</h3>
                <small>{{ plataforma(a.plataforma) }}@if (!a.activo) { · inactivo }</small>
                <small>{{ resumenHorario(a) }}</small>
                <small>{{ a.proximas }} {{ a.proximas === 1 ? 'sesión próxima' : 'sesiones próximas' }}</small>
              </div>
              <button type="button" class="btn" (click)="editarAsesor(a)"><app-icon name="pencil" [size]="15" /> Editar</button>
            </article>
          } @empty {
            <div class="vacio-b"><app-icon name="users" [size]="34" /><p>Aún no hay asesores. Crea el primero para poder agendar sesiones.</p></div>
          }
        </div>
      }

      <!-- ================= INTEGRACIONES ================= -->
      @if (pestana() === 'integraciones') {
        <app-integraciones />
      }

      <!-- ================= SERVICIOS Y REGLAS ================= -->
      @if (pestana() === 'servicios') {
        <section class="card">
          <h3>Menú «Servicios» en cada módulo</h3>
          <p class="nota">Elige en qué módulos ven tus clientes la opción Servicios (avance, sesiones y calendario). Asigna cada servicio a su módulo en Catálogo → Servicios, con el selector de paquete.</p>
          <div class="mods-s">
            @for (m of modsServ(); track m.id) {
              <label class="mod-s" [class.on]="m.habilitado">
                <input type="checkbox" [checked]="m.habilitado" (change)="alternarMod(m, $any($event.target).checked)" />
                <span><b>{{ m.nombre }}</b><small>{{ m.servicios }} {{ m.servicios === 1 ? 'servicio activo' : 'servicios activos' }}</small></span>
              </label>
            }
          </div>
        </section>

        @if (reglas(); as r) {
          <section class="card">
            <h3>Reglas de la agenda</h3>
            <div class="grid3">
              <label>Anticipación mínima para agendar (horas)
                <input type="number" min="0" [value]="r.antelacion_horas" (input)="setRegla('antelacion_horas', $any($event.target).value)" />
              </label>
              <label>Cancelar o reprogramar hasta (horas antes)
                <input type="number" min="0" [value]="r.cancelacion_horas" (input)="setRegla('cancelacion_horas', $any($event.target).value)" />
              </label>
              <label>Días hacia adelante que se pueden reservar
                <input type="number" min="1" [value]="r.dias_adelante" (input)="setRegla('dias_adelante', $any($event.target).value)" />
              </label>
            </div>
            <div class="fila"><button type="button" class="btn primary" (click)="guardarReglas()">Guardar reglas</button></div>
          </section>
        }

        <p class="nota">Define cuántas sesiones incluye cada servicio, cuánto dura cada una y quiénes lo atienden. Si no marcas asesores, lo atiende cualquier asesor activo.</p>
        @for (s of servicios(); track s.id) {
          <section class="card">
            <div class="fila">
              <div class="grande"><small class="cat">{{ s.categoria }}</small><h3>{{ s.nombre }}</h3></div>
              <label class="num">Sesiones incluidas
                <input type="number" min="0" max="20" [value]="s.sesiones" (input)="s.sesiones = aNumero($any($event.target).value, 0)" />
              </label>
              <label class="num">Duración de cada sesión
                <select (change)="s.dur = aNumero($any($event.target).value, 60)">
                  @for (m of duraciones; track m) { <option [value]="m" [selected]="s.dur === m">{{ m }} min</option> }
                </select>
              </label>
            </div>
            <div class="chips">
              @for (a of asesores(); track a.id) {
                <label class="chip-asesor" [class.on]="s.asesorIds.includes(a.id)">
                  <input type="checkbox" [checked]="s.asesorIds.includes(a.id)" (change)="alternarAsesor(s, a.id, $any($event.target).checked)" />
                  <span class="punto" [style.background]="a.color"></span> {{ a.nombre }}
                </label>
              } @empty { <small class="nota">Crea asesores en la pestaña Asesores.</small> }
            </div>
            <div class="fila acciones"><button type="button" class="btn primary" (click)="guardarServicio(s)">Guardar</button></div>
          </section>
        }
      }
    </div>

    <!-- ================= DETALLE DE UN SERVICIO ================= -->
    @if (det(); as d) {
      <div class="overlay lado" (click)="cerrarDet()">
        <aside class="panel" role="dialog" aria-modal="true" aria-label="Detalle del servicio" (click)="$event.stopPropagation()">
          <header class="p-cab">
            <div>
              <small>{{ d.servicio_nombre }}</small>
              <h3>{{ d.nombre }}</h3>
              <span class="estado" [class.ok]="d.estado === 'entregado'" [class.azul]="d.estado === 'en_curso'" [class.bad]="d.estado === 'cancelado'">{{ estadoServicio(d.estado) }}</span>
            </div>
            <button type="button" class="btn ico" aria-label="Cerrar" (click)="cerrarDet()"><app-icon name="x" [size]="18" /></button>
          </header>

          <div class="p-cuerpo">
            <div class="contacto">
              <span><app-icon name="mail" [size]="14" /> {{ d.correo }}</span>
              @if (d.telefono) { <span><app-icon name="phone" [size]="14" /> {{ d.telefono }}</span> }
              @if (d.empresa) { <span><app-icon name="building" [size]="14" /> {{ d.empresa }}</span> }
            </div>
            @if (d.mensaje) { <p class="msg">{{ d.mensaje }}</p> }

            <div>
              <div class="fila-sb"><b>Avance general</b><b>{{ d.progreso }}%</b></div>
              <div class="barra grande-b"><span [style.width.%]="d.progreso"></span></div>
            </div>

            <section>
              <h4>Entregables <small>({{ hechos(d) }} de {{ d.entregables.length }} hechos)</small></h4>
              <ul class="ents">
                @for (e of d.entregables; track e.id) {
                  <li class="ent" [class.hecho]="e.estado === 'hecho'">
                    <div class="e-top">
                      <b>{{ e.titulo }}</b>
                      <button type="button" class="btn ico peligro" aria-label="Quitar entregable" (click)="quitarEnt(e)"><app-icon name="trash" [size]="14" /></button>
                    </div>
                    <div class="seg3">
                      <button type="button" [class.on]="e.estado === 'pendiente'" (click)="setEnt(e, 'pendiente')">Pendiente</button>
                      <button type="button" class="m" [class.on]="e.estado === 'en_curso'" (click)="setEnt(e, 'en_curso')">En curso</button>
                      <button type="button" class="v" [class.on]="e.estado === 'hecho'" (click)="setEnt(e, 'hecho')"><app-icon name="check" [size]="13" /> Hecho</button>
                    </div>
                    <input class="nota-in" placeholder="Nota para este entregable (opcional)" [value]="e.nota" (change)="notaEnt(e, $any($event.target).value)" />
                  </li>
                } @empty { <li class="nota">Este servicio no tiene entregables definidos.</li> }
              </ul>
              <div class="add-ent">
                <input placeholder="Agregar un entregable para este cliente" [value]="nuevoEnt()" (input)="nuevoEnt.set($any($event.target).value)" (keyup.enter)="agregarEnt()" />
                <button type="button" class="btn" (click)="agregarEnt()"><app-icon name="plus" [size]="15" /> Agregar</button>
              </div>
            </section>

            <section>
              <h4>Sesiones <small>({{ d.sesiones_incluidas }} incluidas · {{ d.duracion_min }} min cada una)</small></h4>
              <ul class="sess">
                @for (s of d.sesiones; track s.id) {
                  <li class="ses" [class.cancel]="s.estado === 'cancelada'">
                    <div class="s-top">
                      <span class="punto" [style.background]="s.color"></span>
                      <b>{{ fechaHora(s.inicio) }}</b><small>a {{ hora(s.fin) }}</small>
                      <span class="estado" [class.ok]="s.estado === 'realizada'" [class.azul]="s.estado === 'programada'" [class.bad]="s.estado === 'no_asistio'">{{ estadoSesion(s.estado) }}</span>
                    </div>
                    <small>Con {{ s.asesor }} · {{ plataforma(s.plataforma) }}
                      @if (s.enlace) { · <a [href]="s.enlace" target="_blank" rel="noopener">Abrir sala</a> }
                    </small>
                    @if (s.estado === 'programada') {
                      <div class="s-acc">
                        <button type="button" class="btn" (click)="marcarSesion(s, 'realizada')"><app-icon name="circle-check" [size]="14" /> Realizada</button>
                        <button type="button" class="btn" (click)="marcarSesion(s, 'no_asistio')">No asistió</button>
                        <button type="button" class="btn" (click)="abrirAg(s.id)"><app-icon name="calendar" [size]="14" /> Reprogramar</button>
                        <button type="button" class="btn peligro" (click)="marcarSesion(s, 'cancelada')">Cancelar</button>
                      </div>
                    } @else if (s.estado !== 'realizada') {
                      <div class="s-acc"><button type="button" class="btn" (click)="marcarSesion(s, 'programada')">Reactivar</button></div>
                    }
                  </li>
                } @empty { <li class="nota">Todavía no hay sesiones agendadas.</li> }
              </ul>

              @if (d.pendientes_agendar > 0 && !ag()) {
                <button type="button" class="btn primary" (click)="abrirAg(null)">
                  <app-icon name="calendar" [size]="16" /> Agendar sesión ({{ d.pendientes_agendar }} pendiente{{ d.pendientes_agendar === 1 ? '' : 's' }})
                </button>
              }

              @if (ag(); as g) {
                <div class="picker">
                  <div class="fila-sb"><b>{{ g.sesionId ? 'Reprogramar sesión' : 'Agendar sesión' }}</b>
                    <button type="button" class="btn ico" aria-label="Cerrar" (click)="ag.set(null)"><app-icon name="x" [size]="15" /></button>
                  </div>
                  <label>Día
                    <input type="date" [value]="g.fecha" [min]="diaISO(0)" (change)="cambiarFecha($any($event.target).value)" />
                  </label>
                  <div class="slots">
                    @for (s of g.slots; track s.inicio + '-' + s.asesor_id) {
                      <button type="button" class="slot" (click)="elegir(s)">{{ hora(s.inicio) }}<small>{{ s.asesor }}</small></button>
                    } @empty {
                      <p class="nota">{{ g.cargando ? 'Buscando horarios…' : 'No hay horarios libres ese día. Prueba otro o revisa los horarios de los asesores.' }}</p>
                    }
                  </div>
                </div>
              }
            </section>
          </div>
        </aside>
      </div>
    }

    <!-- ================= EDITOR DE ASESOR ================= -->
    @if (ed(); as a) {
      <div class="overlay" (click)="cerrarAsesor()">
        <div class="modal ancho" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <header class="m-cab">
            <h3>{{ a.id === null ? 'Nuevo asesor' : 'Editar asesor' }}</h3>
            <button type="button" class="btn ico" aria-label="Cerrar" (click)="cerrarAsesor()"><app-icon name="x" [size]="18" /></button>
          </header>
          <div class="grid2">
            <label>Nombre <input [value]="a.nombre" (input)="setEd({ nombre: $any($event.target).value })" /></label>
            <label>Correo (recibe aviso de cada sesión)
              <input type="email" [value]="a.correo" (input)="setEd({ correo: $any($event.target).value })" />
            </label>
            <label>Plataforma
              <select (change)="setEd({ plataforma: $any($event.target).value })">
                <option value="meet" [selected]="a.plataforma === 'meet'">Google Meet</option>
                <option value="zoom" [selected]="a.plataforma === 'zoom'">Zoom</option>
                <option value="otra" [selected]="a.plataforma === 'otra'">Otra</option>
              </select>
            </label>
            <label>Cómo se crea el enlace de cada sesión
              <select (change)="setEd({ modoEnlace: $any($event.target).value })">
                <option value="fijo" [selected]="a.modoEnlace === 'fijo'">Enlace fijo de su sala</option>
                <option value="api" [selected]="a.modoEnlace === 'api'">Automático (un enlace nuevo por sesión)</option>
              </select>
            </label>
            @if (a.modoEnlace === 'api' && a.plataforma === 'zoom') {
              <label>Correo de su cuenta de Zoom (si lo dejas vacío se usa la cuenta anfitriona)
                <input type="email" [value]="a.zoomUsuario" (input)="setEd({ zoomUsuario: $any($event.target).value })" />
              </label>
            }
            @if (a.modoEnlace === 'api' && a.plataforma === 'otra') {
              <p class="nota">El modo automático solo existe para Zoom y Google Meet. Con "Otra" se usa el enlace fijo.</p>
            }
            <label>Enlace de su sala (https). Es el respaldo si falla el modo automático
              <input placeholder="https://meet.google.com/abc-defg-hij" [value]="a.enlace" (input)="setEd({ enlace: $any($event.target).value })" />
            </label>
            <label>Color en el calendario <input type="color" [value]="a.color" (input)="setEd({ color: $any($event.target).value })" /></label>
            <label class="chk"><input type="checkbox" [checked]="a.activo" (change)="setEd({ activo: $any($event.target).checked })" /> Activo (recibe sesiones)</label>
          </div>
        @if (a.id !== null) {
            <section class="acceso">
              <div>
                <b>Acceso a la plataforma</b>
                <small>
                  @if (a.usuarioId) { Tiene usuario ({{ a.correo }}) y entra a «Mi agenda». }
                  @else { Sin acceso. Con acceso verá solo su agenda y sus clientes. Guarda sus datos antes de darle acceso. }
                </small>
              </div>
              <div class="fila">
                <button type="button" class="btn primary" (click)="darAcceso()">{{ a.usuarioId ? 'Reenviar invitación' : 'Dar acceso' }}</button>
                @if (a.usuarioId) { <button type="button" class="btn peligro" (click)="quitarAcceso()">Quitar acceso</button> }
              </div>
            </section>
          }
          <div class="pie">
            @if (a.id !== null) { <button type="button" class="btn peligro" (click)="borrarAsesor()"><app-icon name="trash" [size]="15" /> Eliminar</button> }
            <button type="button" class="btn primary" (click)="guardarAsesor()">{{ a.id === null ? 'Crear asesor' : 'Guardar datos' }}</button>
          </div>

          @if (a.id !== null) {
            <section class="bloque">
              <h4>Horario semanal</h4>
              <p class="nota">Los rangos en los que este asesor atiende. Las sesiones se ofrecen dentro de ellos.</p>
              @for (d of dias; track d.i) {
                <div class="dia">
                  <b>{{ d.n }}</b>
                  <div class="rangos">
                    @for (h of horDe(d.i); track $index) {
                      <span class="rango">
                        <input type="time" [value]="h.inicio" (change)="setHor(h, 'inicio', $any($event.target).value)" />
                        <span>a</span>
                        <input type="time" [value]="h.fin" (change)="setHor(h, 'fin', $any($event.target).value)" />
                        <button type="button" class="x" aria-label="Quitar rango" (click)="quitarHor(h)"><app-icon name="x" [size]="14" /></button>
                      </span>
                    } @empty { <small class="nota">No atiende</small> }
                    <button type="button" class="btn" (click)="agregarHor(d.i)"><app-icon name="plus" [size]="14" /> Rango</button>
                  </div>
                </div>
              }
              <div class="fila"><button type="button" class="btn primary" (click)="guardarHorarios()">Guardar horario</button></div>
            </section>

            <section class="bloque">
              <h4>Bloqueos (permisos, vacaciones)</h4>
              <ul class="bloq">
                @for (b of a.bloqueos; track b.id) {
                  <li><span>{{ fechaHora(b.desde) }} → {{ fechaHora(b.hasta) }}@if (b.motivo) { · {{ b.motivo }} }</span>
                    <button type="button" class="btn ico peligro" aria-label="Quitar bloqueo" (click)="quitarBloqueo(b)"><app-icon name="trash" [size]="14" /></button>
                  </li>
                } @empty { <li class="nota">Sin bloqueos próximos.</li> }
              </ul>
              <div class="fila">
                <label>Desde <input type="datetime-local" [value]="blq().desde" (input)="setBlq({ desde: $any($event.target).value })" /></label>
                <label>Hasta <input type="datetime-local" [value]="blq().hasta" (input)="setBlq({ hasta: $any($event.target).value })" /></label>
                <label class="grande">Motivo <input [value]="blq().motivo" (input)="setBlq({ motivo: $any($event.target).value })" /></label>
                <button type="button" class="btn" (click)="agregarBloqueo()"><app-icon name="plus" [size]="15" /> Bloquear</button>
              </div>
            </section>
          }
        </div>
      </div>
    }
  `,
  styles: [ESTILOS_ADMIN, `
    .barra { height: 7px; border-radius: 999px; background: #e8edf8; overflow: hidden; margin-bottom: 4px; }
    .barra span { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #1d4ed8, #2f6bff); transition: width .4s; }
    .barra.grande-b { height: 10px; margin-top: 6px; } .avance { min-width: 190px; }
    .alerta { color: #b45309 !important; font-weight: 600; } .estado.azul { background: #dbeafe; color: #1d4ed8; }
    .barra-sup { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; } .barra-sup .nota { margin: 0; max-width: 620px; }
    .ases { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
    .ase { display: flex; align-items: center; gap: 16px; padding: 18px; background: #fff; border: 1px solid var(--line); border-radius: 16px; } .ase.off { opacity: .6; }
    .av { display: grid; place-items: center; width: 52px; height: 52px; border-radius: 14px; color: #fff; font-weight: 700; flex: none; }
    .ase-t { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; } .ase-t h3 { margin: 0; } .ase-t small { color: var(--muted); }
    .vacio-b { grid-column: 1 / -1; display: grid; justify-items: center; gap: 8px; padding: 50px 20px; color: var(--muted); background: #fff; border: 1px dashed #c3cde6; border-radius: 16px; } .vacio-b p { margin: 0; }
    .grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; } .cat { color: var(--muted); font-size: .76rem; text-transform: uppercase; letter-spacing: .06em; }
    .chip-asesor { display: inline-flex; flex-direction: row; align-items: center; gap: 8px; padding: 7px 14px; border: 1px solid var(--line); border-radius: 999px; background: #fff; font-weight: 600; cursor: pointer; }
    .chip-asesor input { display: none; } .chip-asesor.on { background: var(--soft); border-color: var(--brand); color: var(--brand); }
    .punto { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
    .overlay.lado { place-items: stretch end; padding: 0; }
    .panel { width: min(660px, 100%); height: 100vh; overflow-y: auto; display: flex; flex-direction: column; background: #fff; box-shadow: -30px 0 70px -30px rgb(10 26 58 / .55); animation: entra .28s cubic-bezier(.2, .8, .2, 1); }
    @keyframes entra { from { transform: translateX(40px); opacity: 0; } }
    .p-cab { position: sticky; top: 0; z-index: 2; display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 20px 24px; background: linear-gradient(180deg, #f8faff, #fff); border-bottom: 1px solid var(--line); }
    .p-cab small { color: var(--muted); } .p-cab h3 { margin: 2px 0 8px; font-size: 1.25rem; }
    .p-cuerpo { display: flex; flex-direction: column; gap: 20px; padding: 20px 24px 60px; }
    .contacto { display: flex; gap: 8px 18px; flex-wrap: wrap; font-size: .86rem; color: #334155; } .contacto span { display: inline-flex; align-items: center; gap: 6px; }
    .fila-sb { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    h4 small { font-weight: 400; color: var(--muted); }
    .ents, .sess, .bloq { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .ent { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 14px; background: #fff; } .ent.hecho { background: #f3fbf7; border-color: #bfe8d3; }
    .e-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; } .e-top b { font-size: .9rem; line-height: 1.4; } .e-top .btn { height: 30px; width: 30px; margin: 0; }
    .seg3 { display: inline-flex; width: fit-content; padding: 3px; background: #e8edf8; border-radius: 10px; }
    .seg3 button { display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; border: 0; border-radius: 8px; background: none; font: inherit; font-size: .78rem; font-weight: 600; color: var(--muted); cursor: pointer; }
    .seg3 button.on { background: #fff; color: #0f172a; box-shadow: 0 1px 3px rgb(10 26 58 / .15); } .seg3 .m.on { color: #1d4ed8; } .seg3 .v.on { color: #047857; }
    .nota-in { height: 34px !important; font-size: .82rem !important; }
    .add-ent { display: flex; gap: 8px; margin-top: 10px; } .add-ent input { flex: 1; }
    .ses { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 14px; } .ses.cancel { opacity: .55; }
    .s-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; } .ses small { color: var(--muted); } .ses small a { color: var(--brand); font-weight: 600; }
    .s-acc { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; } .s-acc .btn { height: 34px; font-size: .78rem; padding: 0 12px; }
    .picker { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; padding: 14px; background: #f8faff; border: 1px solid #c7d6fb; border-radius: 14px; }
    .slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 8px; }
    .slot { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 10px 6px; border: 1px solid var(--line); border-radius: 12px; background: #fff; font: inherit; font-weight: 700; cursor: pointer; transition: .15s; }
    .slot small { font-weight: 500; color: var(--muted); font-size: .72rem; } .slot:hover { border-color: var(--brand); background: var(--soft); color: var(--brand); }
    .modal.ancho { width: min(760px, 100%); } .m-cab { display: flex; justify-content: space-between; align-items: center; }
    .bloque { padding-top: 14px; border-top: 1px solid var(--line); } .dia { display: flex; gap: 14px; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid #f0f3fa; } .dia > b { width: 92px; flex: none; padding-top: 8px; font-size: .88rem; }
    .rangos { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; } .rango { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; background: #f8faff; border: 1px solid var(--line); border-radius: 10px; }
    .rango input { height: 34px; width: 112px; } .rango .x { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; color: var(--muted); } .rango .x:hover { background: #fef2f2; color: #b91c1c; }
    .bloq li { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 8px 12px; background: #fafbfe; border: 1px solid var(--line); border-radius: 10px; font-size: .86rem; }
    .acceso { display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 14px; padding: 14px 16px; background: #f8faff; border: 1px solid #c7d6fb; border-radius: 14px; }
    .acceso > div:first-child { display: flex; flex-direction: column; gap: 3px; max-width: 460px; } .acceso small { color: var(--muted); }
    .mods-s { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .mod-s { display: flex; flex-direction: row; align-items: center; gap: 12px; padding: 14px 16px; background: #fff; border: 1px solid var(--line); border-radius: 14px; cursor: pointer; }
    .mod-s.on { background: var(--soft); border-color: var(--brand); } .mod-s input { width: 18px; height: 18px; accent-color: var(--brand); }
    .mod-s span { display: flex; flex-direction: column; } .mod-s small { color: var(--muted); font-weight: 400; }
    @media (max-width: 800px) { .grid3 { grid-template-columns: 1fr; } .dia { flex-direction: column; gap: 4px; } .dia > b { padding-top: 0; } }
  `],
})
export class AgendaAdminPage implements OnInit {
  private readonly api: AgendaAdminService = inject(AgendaAdminService);
  private readonly rt: TiempoRealService = inject(TiempoRealService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);
  readonly dias = DIAS;
  readonly filtros = FILTROS;
  readonly duraciones = [30, 45, 60, 90, 120];

  readonly pestana = signal<Pestana>('seguimiento');
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');

  // Seguimiento
  readonly pedidos = signal<PedidoSeg[]>([]);
  readonly filtro = signal<Filtro>('todos');
  readonly det = signal<PedidoDetalle | null>(null);
  readonly ag = signal<Agendar | null>(null);
  readonly nuevoEnt = signal<string>('');

  // Asesores
  readonly asesores = signal<Asesor[]>([]);
  readonly ed = signal<EdAsesor | null>(null);
  readonly hor = signal<Horario[]>([]);
  readonly blq = signal<{ desde: string; hasta: string; motivo: string }>({ desde: '', hasta: '', motivo: '' });

  // Servicios y reglas
  readonly servicios = signal<ServEdit[]>([]);
  readonly reglas = signal<Reglas | null>(null);
  readonly modsServ = signal<ModuloServicios[]>([]);

  readonly visibles = computed<PedidoSeg[]>(() => this.pedidos().filter((p) => this.coincide(p, this.filtro())));

  ngOnInit(): void {
    this.cargarPedidos();
    this.cargarAsesores();
    this.cargarServicios();
    this.cargarModsServ();
    if (new URLSearchParams(location.search).has('google')) this.pestana.set('integraciones');
    this.cargarReglas();
    // Tiempo real: cualquier cambio en un servicio o sesión se refleja sin recargar
    this.rt.cambios('agenda', 'horarios').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.alCambiar());
  }

  // ---------------- Utilidades ----------------
  private ok(t: string): void { this.error.set(''); this.mensaje.set(t); }
  private fallo(e: HttpErrorResponse): void { this.mensaje.set(''); this.error.set(this.msg(e)); }
  irA(p: Pestana): void { this.pestana.set(p); this.mensaje.set(''); this.error.set(''); }
  aNumero(v: string, def: number): number { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 ? n : def; }
  estadoServicio(e: EstadoServicio | string): string { return ESTADO_SERVICIO[e] ?? e; }
  estadoSesion(e: EstadoSesion | string): string { return ESTADO_SESION[e] ?? e; }
  plataforma(p: string): string { return PLATAFORMA[p] ?? p; }
  iniciales(n: string): string { return n.split(/\s+/).slice(0, 2).map((x) => x.charAt(0)).join('').toUpperCase(); }

  fechaHora(iso: string): string {
    return new Date(iso).toLocaleString('es-PE', { timeZone: ZONA, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  hora(iso: string): string {
    return new Date(iso).toLocaleTimeString('es-PE', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hour12: false });
  }
  diaISO(offset: number): string {
    return new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: ZONA });
  }

  // ---------------- Seguimiento ----------------
  faltaAgendar(p: PedidoSeg): boolean {
    return p.sesiones_incluidas > p.programadas + p.realizadas && p.estado !== 'entregado' && p.estado !== 'cancelado';
  }
  private coincide(p: PedidoSeg, f: Filtro): boolean {
    if (f === 'todos') return true;
    if (f === 'agendar') return this.faltaAgendar(p);
    return p.estado === f;
  }
  cuenta(f: Filtro): number { return this.pedidos().filter((p) => this.coincide(p, f)).length; }
  hechos(d: PedidoDetalle): number { return d.entregables.filter((e) => e.estado === 'hecho').length; }

  cargarPedidos(): void {
    this.api.pedidos().subscribe({ next: (l) => this.pedidos.set(l), error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  abrir(id: number): void {
    this.ag.set(null);
    this.nuevoEnt.set('');
    this.recargarDet(id);
  }

  private recargarDet(id: number): void {
    this.api.pedido(id).subscribe({ next: (d) => this.det.set(d), error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  cerrarDet(): void { this.det.set(null); this.ag.set(null); }

  /** Después de cada cambio se vuelve a leer el detalle y la lista (el servidor recalcula el estado). */
  private refrescar(): void {
    const d = this.det();
    if (d) this.recargarDet(d.id);
    this.cargarPedidos();
  }

  setEnt(e: Entregable, estado: EstadoEntregable): void {
    this.api.editarEntregable(e.id, { estado }).subscribe({ next: () => this.refrescar(), error: (er: HttpErrorResponse) => this.fallo(er) });
  }

  notaEnt(e: Entregable, nota: string): void {
    if (nota.trim() === e.nota) return;
    this.api.editarEntregable(e.id, { nota }).subscribe({ next: () => this.ok('Nota guardada'), error: (er: HttpErrorResponse) => this.fallo(er) });
  }

  quitarEnt(e: Entregable): void {
    if (!confirm(`¿Quitar el entregable "${e.titulo}" de este cliente?`)) return;
    this.api.quitarEntregable(e.id).subscribe({ next: () => this.refrescar(), error: (er: HttpErrorResponse) => this.fallo(er) });
  }

  agregarEnt(): void {
    const d = this.det();
    const t = this.nuevoEnt().trim();
    if (!d || t.length < 2) return;
    this.api.agregarEntregable(d.id, t).subscribe({
      next: () => { this.nuevoEnt.set(''); this.refrescar(); },
      error: (er: HttpErrorResponse) => this.fallo(er),
    });
  }

  marcarSesion(s: SesionFila, estado: EstadoSesion): void {
    if (estado === 'cancelada' && !confirm('¿Cancelar esta sesión?')) return;
    this.api.editarSesion(s.id, { estado }).subscribe({
      next: () => { this.ok(`Sesión ${this.estadoSesion(estado).toLowerCase()}`); this.refrescar(); },
      error: (er: HttpErrorResponse) => this.fallo(er),
    });
  }

  // Selector de horarios (agendar o reprogramar)
  abrirAg(sesionId: number | null): void {
    this.ag.set({ sesionId, fecha: this.diaISO(1), slots: [], cargando: true });
    this.cargarSlots();
  }

  cambiarFecha(f: string): void {
    this.ag.update((g) => (g ? { ...g, fecha: f, slots: [], cargando: true } : g));
    this.cargarSlots();
  }

  private cargarSlots(): void {
    const d = this.det();
    const g = this.ag();
    if (!d || !g) return;
    this.api.horarios(d.id, g.fecha, 1).subscribe({
      next: (s) => this.ag.update((x) => (x && x.fecha === g.fecha ? { ...x, slots: s, cargando: false } : x)),
      error: (e: HttpErrorResponse) => { this.ag.update((x) => (x ? { ...x, cargando: false } : x)); this.fallo(e); },
    });
  }

  elegir(s: Slot): void {
    const d = this.det();
    const g = this.ag();
    if (!d || !g) return;
    const obs = g.sesionId === null
      ? this.api.agendar(d.id, { asesor_id: s.asesor_id, inicio: s.inicio })
      : this.api.editarSesion(g.sesionId, { inicio: s.inicio, asesor_id: s.asesor_id });
    obs.subscribe({
      next: (r) => {
        this.ag.set(null);
        const aviso = (r as { aviso?: string } | null)?.aviso;
        this.ok(aviso ? `Sesión guardada. ${aviso}` : 'Sesión guardada. Se envió el correo con la fecha y el enlace.');
        this.refrescar();
      },
      error: (e: HttpErrorResponse) => { this.fallo(e); this.cargarSlots(); },
    });
  }

  // ---------------- Asesores ----------------
  cargarAsesores(abrirId?: number): void {
    this.api.asesores().subscribe({
      next: (l) => {
        this.asesores.set(l);
        const actual = this.ed();
        const objetivo = abrirId ?? actual?.id ?? null;
        const a = l.find((x) => x.id === objetivo);
        if (a && (abrirId !== undefined || actual?.id === a.id)) {
          this.ed.set({ id: a.id, nombre: a.nombre, correo: a.correo, plataforma: a.plataforma, enlace: a.enlace, color: a.color, activo: a.activo, bloqueos: a.bloqueos, modoEnlace: a.modo_enlace, zoomUsuario: a.zoom_usuario, usuarioId: a.usuario_id });
          if (abrirId !== undefined) { this.hor.set(a.horarios.map((h) => ({ ...h }))); this.horSucio = false; }
        }
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  resumenHorario(a: Asesor): string {
    if (!a.horarios.length) return 'Sin horario configurado';
    const dias = [...new Set(a.horarios.map((h) => h.dia))].sort().map((d) => DIAS[d].n.slice(0, 3));
    return `Atiende: ${dias.join(', ')}`;
  }

  nuevoAsesor(): void {
    this.hor.set([]);
    this.ed.set({ id: null, nombre: '', correo: '', plataforma: 'meet', enlace: '', color: '#1d4ed8', activo: true, bloqueos: [], modoEnlace: 'fijo', zoomUsuario: '', usuarioId: null });
  }

  editarAsesor(a: Asesor): void { this.cargarAsesores(a.id); }
  cerrarAsesor(): void { this.ed.set(null); }
  setEd(c: Partial<EdAsesor>): void { this.ed.update((a) => (a ? { ...a, ...c } : a)); }

  guardarAsesor(): void {
    const a = this.ed();
    if (!a) return;
    if (a.nombre.trim().length < 2) { this.mensaje.set(''); this.error.set('Escribe el nombre del asesor'); return; }
    const cuerpo = {
      nombre: a.nombre.trim(), correo: a.correo.trim(), plataforma: a.plataforma, enlace: a.enlace.trim(), color: a.color,
      activo: a.activo, modo_enlace: a.modoEnlace, zoom_usuario: a.zoomUsuario.trim(),
    };
    if (a.id === null) {
      this.api.crearAsesor(cuerpo).subscribe({
        next: (r) => { this.ok('Asesor creado. Ahora define su horario semanal.'); this.cargarAsesores(r.id); },
        error: (e: HttpErrorResponse) => this.fallo(e),
      });
    } else {
      this.api.editarAsesor(a.id, cuerpo).subscribe({
        next: () => { this.ok('Datos guardados'); this.cargarAsesores(); },
        error: (e: HttpErrorResponse) => this.fallo(e),
      });
    }
  }

  darAcceso(): void {
    const a = this.ed();
    if (!a || a.id === null) return;
    if (!a.correo.trim()) { this.mensaje.set(''); this.error.set('Primero guarda el correo del asesor: ahí llegará su invitación'); return; }
    this.api.darAcceso(a.id).subscribe({
      next: () => { this.ok(`Invitación enviada a ${a.correo.trim()}. Podrá crear su clave desde el enlace del correo.`); this.cargarAsesores(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  quitarAcceso(): void {
    const a = this.ed();
    if (!a || a.id === null || !confirm(`¿Quitar el acceso de ${a.nombre}? Su sesión se cierra de inmediato.`)) return;
    this.api.quitarAcceso(a.id).subscribe({
      next: () => { this.ok('Acceso retirado'); this.cargarAsesores(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  cargarModsServ(): void {
    this.api.modulosServicios().subscribe({ next: (l) => this.modsServ.set(l), error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  alternarMod(m: ModuloServicios, on: boolean): void {
    const nuevo = this.modsServ().map((x) => (x.id === m.id ? { ...x, habilitado: on } : x));
    this.modsServ.set(nuevo);
    this.api.fijarModulosServicios(Object.fromEntries(nuevo.map((x) => [x.id, x.habilitado]))).subscribe({
      next: () => this.ok(`Servicios ${on ? 'habilitado' : 'oculto'} en ${m.nombre}`),
      error: (e: HttpErrorResponse) => { this.fallo(e); this.cargarModsServ(); },
    });
  }

  /** Cambió algo en la agenda: se refresca lo que estás viendo sin pisar lo que estás escribiendo. */
  private alCambiar(): void {
    this.cargarPedidos();
    const d = this.det();
    if (d) this.recargarDet(d.id);
    if (this.ag()) this.cargarSlots();
    this.refrescarAsesores();
    this.cargarServicios(true);
    this.cargarReglas(true);
    this.cargarModsServ();
  }

  /** Actualiza las tarjetas y, si el editor está abierto, solo sus bloqueos, su acceso y su horario (si no lo estás editando). */
  private refrescarAsesores(): void {
    this.api.asesores().subscribe({
      next: (l) => {
        this.asesores.set(l);
        const ed = this.ed();
        if (!ed || ed.id === null) return;
        const a = l.find((x) => x.id === ed.id);
        if (!a) { this.ed.set(null); this.mensaje.set(''); this.error.set('Este asesor ya no existe'); return; }
        this.ed.update((x) => (x ? { ...x, bloqueos: a.bloqueos, usuarioId: a.usuario_id } : x));
        if (!this.horSucio) this.hor.set(a.horarios.map((h) => ({ ...h })));
      },
      error: () => undefined,
    });
  }

  private reglasOrig = '';

  /** preservar = true: si estás editando las reglas, no se pisan. */
  cargarReglas(preservar = false): void {
    this.api.reglas().subscribe({
      next: (r) => {
        if (preservar && this.reglas() !== null && JSON.stringify(this.reglas()) !== this.reglasOrig) return;
        this.reglas.set(r);
        this.reglasOrig = JSON.stringify(r);
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  private snap(s: { sesiones: number; dur: number; asesorIds: number[] }): string {
    return JSON.stringify([s.sesiones, s.dur, [...s.asesorIds].sort((a, b) => a - b)]);
  }

  borrarAsesor(): void {
    const a = this.ed();
    if (!a || a.id === null || !confirm(`¿Eliminar a ${a.nombre}?`)) return;
    this.api.borrarAsesor(a.id).subscribe({
      next: () => { this.cerrarAsesor(); this.ok('Asesor eliminado'); this.cargarAsesores(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  horDe(dia: number): Horario[] { return this.hor().filter((h) => h.dia === dia); }
  private horSucio = false;
  agregarHor(dia: number): void { this.horSucio = true; this.hor.update((l) => [...l, { dia, inicio: '09:00', fin: '13:00' }]); }
  quitarHor(h: Horario): void { this.horSucio = true; this.hor.update((l) => l.filter((x) => x !== h)); }
  setHor(h: Horario, campo: 'inicio' | 'fin', v: string): void {
    this.horSucio = true;
    this.hor.update((l) => l.map((x) => (x === h ? { ...x, [campo]: v } : x)));
  }

  guardarHorarios(): void {
    const a = this.ed();
    if (!a || a.id === null) return;
    this.api.fijarHorarios(a.id, this.hor()).subscribe({
      next: () => { this.horSucio = false; this.ok('Horario guardado'); this.cargarAsesores(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  setBlq(c: Partial<{ desde: string; hasta: string; motivo: string }>): void { this.blq.update((b) => ({ ...b, ...c })); }

  agregarBloqueo(): void {
    const a = this.ed();
    const b = this.blq();
    if (!a || a.id === null) return;
    if (!b.desde || !b.hasta) { this.mensaje.set(''); this.error.set('Indica desde y hasta cuándo'); return; }
    this.api.crearBloqueo(a.id, {
      desde: new Date(b.desde).toISOString(), hasta: new Date(b.hasta).toISOString(), motivo: b.motivo.trim(),
    }).subscribe({
      next: () => { this.blq.set({ desde: '', hasta: '', motivo: '' }); this.ok('Bloqueo agregado'); this.cargarAsesores(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  quitarBloqueo(b: Bloqueo): void {
    this.api.borrarBloqueo(b.id).subscribe({ next: () => this.cargarAsesores(), error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  // ---------------- Servicios y reglas ----------------
  /** preservar = true: las filas que estás editando no se pisan; las demás se actualizan. */
  cargarServicios(preservar = false): void {
    this.api.servicios().subscribe({
      next: (l) => {
        const locales = new Map(this.servicios().map((s) => [s.id, s]));
        this.servicios.set(l.map((s) => {
          const fresco: ServEdit = {
            id: s.id, categoria: s.categoria, nombre: s.nombre, sesiones: s.sesiones, dur: s.duracion_sesion_min,
            asesorIds: [...s.asesor_ids], orig: '',
          };
          fresco.orig = this.snap(fresco);
          const local = locales.get(s.id);
          return preservar && local && this.snap(local) !== local.orig ? local : fresco;
        }));
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  alternarAsesor(s: ServEdit, id: number, on: boolean): void {
    s.asesorIds = on ? [...new Set([...s.asesorIds, id])] : s.asesorIds.filter((x) => x !== id);
  }

  guardarServicio(s: ServEdit): void {
    this.api.fijarServicio(s.id, { sesiones: s.sesiones, duracion_min: s.dur, asesor_ids: s.asesorIds }).subscribe({
      next: () => { s.orig = this.snap(s); this.ok(`"${s.nombre}" guardado`); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  setRegla(campo: keyof Reglas, v: string): void {
    this.reglas.update((r) => (r ? { ...r, [campo]: this.aNumero(v, r[campo]) } : r));
  }

  guardarReglas(): void {
    const r = this.reglas();
    if (!r) return;
    this.api.fijarReglas(r).subscribe({ next: () => { this.reglasOrig = JSON.stringify(r); this.ok('Reglas guardadas'); }, error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  private msg(e: HttpErrorResponse): string {
    const d = e.error?.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return 'Revisa los datos: hay campos vacíos o con formato inválido.';
    return 'No se pudo conectar con el servidor';
  }
}