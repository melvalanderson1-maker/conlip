import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { switchMap } from 'rxjs';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import {
  EmpresaFila, Modo, Periodo, PlanFila, PlataformaService, PrecioFila, Resumen, SuscripcionFila,
} from './plataforma.service';

type Pestana = 'clientes' | 'planes' | 'nuevo';
interface SubForm { codigo: string; nombre: string; marcado: boolean; modo: Modo; periodo: Periodo; }
interface PlanEdit {
  id: number; codigo: string; nombre: string; descripcion: string; en_venta: boolean;
  precios: Record<string, string>;
}

const FILAS = [
  { clave: 'persona|ver', label: 'Persona · Visualizar' },
  { clave: 'persona|cotizar', label: 'Persona · Cotizar' },
  { clave: 'empresa|ver', label: 'Empresa · Visualizar' },
  { clave: 'empresa|cotizar', label: 'Empresa · Cotizar (incluye el cupo de usuarios)' },
  { clave: 'empresa|usuario_extra', label: 'Empresa · Usuario extra' },
];

@Component({
  selector: 'app-plataforma',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <div class="cab">
        <div>
          <span class="eyebrow">Administración</span>
          <h2>Plataforma</h2>
          <p class="sub">Clientes, suscripciones, paquetes y precios.</p>
        </div>
      </div>

      <div class="tabs">
        <button type="button" [class.on]="pestana() === 'clientes'" (click)="irA('clientes')">Clientes</button>
        <button type="button" [class.on]="pestana() === 'planes'" (click)="irA('planes')">Paquetes y precios</button>
        <button type="button" [class.on]="pestana() === 'nuevo'" (click)="irA('nuevo')">Nuevo cliente</button>
      </div>

      @if (mensaje()) { <p class="ok">{{ mensaje() }}</p> }
      @if (error()) { <p class="error">{{ error() }}</p> }

      <!-- ============ CLIENTES ============ -->
      @if (pestana() === 'clientes') {
        @if (resumen(); as r) {
          <div class="kpis">
            <div class="kpi"><b>{{ r.empresas }}</b><span>Empresas</span></div>
            <div class="kpi"><b>{{ r.personas }}</b><span>Personas naturales</span></div>
            <div class="kpi"><b>{{ r.suscripciones_activas }}</b><span>Suscripciones activas</span></div>
            <div class="kpi warn"><b>{{ r.por_vencer }}</b><span>Vencen en 30 días</span></div>
          </div>
        }

        <div class="chips">
          <button type="button" class="chip" [class.on]="filtroTipo() === ''" (click)="setTipo('')">Todos</button>
          <button type="button" class="chip" [class.on]="filtroTipo() === 'empresa'" (click)="setTipo('empresa')">Empresas</button>
          <button type="button" class="chip" [class.on]="filtroTipo() === 'persona'" (click)="setTipo('persona')">Personas</button>
        </div>

        <div class="tabla-wrap">
          <table class="tabla">
            <thead><tr><th>Cliente</th><th>Tipo</th><th>Usuarios</th><th>Suscripciones</th><th>Estado</th><th></th></tr></thead>
            <tbody>
              @for (e of empresas(); track e.id) {
                <tr [class.off]="!e.activo">
                  <td><b>{{ e.nombre }}</b><br /><small>{{ e.doc_tipo }} {{ e.doc_numero }} · {{ e.correo }}</small></td>
                  <td>{{ e.tipo === 'empresa' ? 'Empresa' : 'Persona' }}</td>
                  <td>{{ e.usuarios }} / {{ e.cupo_usuarios }}</td>
                  <td class="subs">
                    @for (s of e.suscripciones; track s.id) {
                      <span class="sub-chip" [class.venc]="!s.vigente || s.estado !== 'activa'" [class.pronto]="proximo(s)">
                        {{ s.nombre }} · {{ s.modo === 'cotizar' ? 'Cotizar' : 'Ver' }} · {{ s.periodo }} · vence {{ fecha(s.vence_en) }}
                        @if (s.estado === 'activa') {
                          <button type="button" class="x" title="Cancelar suscripción" (click)="cancelarSub(s)">×</button>
                        }
                      </span>
                    } @empty { <small>Sin suscripciones</small> }
                  </td>
                  <td>{{ e.activo ? 'Activo' : 'Suspendido' }}</td>
                  <td class="btns">
                    <button type="button" class="btn" (click)="abrirRenovar(e)">Agregar / renovar</button>
                    <button type="button" class="btn" (click)="cambiarCupo(e)">Cupo</button>
                    <button type="button" class="btn" (click)="alternarEmpresa(e)">{{ e.activo ? 'Suspender' : 'Activar' }}</button>
                  </td>
                </tr>
                @if (renovando() === e.id) {
                  <tr class="extra">
                    <td colspan="6">
                      <div class="renovar">
                        <select (change)="rPlan.set($any($event.target).value)">
                          @for (p of planes(); track p.codigo) {
                            <option [value]="p.codigo" [selected]="rPlan() === p.codigo">{{ p.nombre }}</option>
                          }
                        </select>
                        <select (change)="rModo.set($any($event.target).value)">
                          <option value="ver" [selected]="rModo() === 'ver'">Solo visualizar</option>
                          <option value="cotizar" [selected]="rModo() === 'cotizar'">Cotizar</option>
                        </select>
                        <select (change)="rPeriodo.set($any($event.target).value)">
                          <option value="mensual" [selected]="rPeriodo() === 'mensual'">Mensual (+1 mes)</option>
                          <option value="anual" [selected]="rPeriodo() === 'anual'">Anual (+1 año)</option>
                        </select>
                        <button type="button" class="btn primary" (click)="renovar(e)">Aplicar</button>
                        <button type="button" class="btn" (click)="renovando.set(null)">Cerrar</button>
                      </div>
                    </td>
                  </tr>
                }
              } @empty {
                <tr><td colspan="6" class="vacio">Aún no hay clientes.</td></tr>
              }
            </tbody>
          </table>
        </div>
      }

      <!-- ============ PAQUETES Y PRECIOS ============ -->
      @if (pestana() === 'planes') {
        <p class="nota">Una celda vacía significa que ese precio <b>no se vende</b>. Precios en soles (S/).</p>
        <div class="planes">
          @for (p of planesEdit(); track p.id; let i = $index) {
            <section class="plan">
              <div class="plan-cab">
                <input class="plan-nombre" [value]="p.nombre" (input)="setPlan(i, 'nombre', $any($event.target).value)" />
                <label class="venta">
                  <input type="checkbox" [checked]="p.en_venta" (change)="setEnVenta(i, $any($event.target).checked)" />
                  En venta
                </label>
              </div>
              <input class="plan-desc" placeholder="Descripción" [value]="p.descripcion"
                     (input)="setPlan(i, 'descripcion', $any($event.target).value)" />
              <table class="precios">
                <thead><tr><th>Concepto</th><th>Mensual</th><th>Anual</th></tr></thead>
                <tbody>
                  @for (f of filas; track f.clave) {
                    <tr>
                      <td>{{ f.label }}</td>
                      <td><input type="number" min="0" step="0.01" [value]="p.precios[f.clave + '|mensual']"
                                 (input)="setPrecio(i, f.clave + '|mensual', $any($event.target).value)" /></td>
                      <td><input type="number" min="0" step="0.01" [value]="p.precios[f.clave + '|anual']"
                                 (input)="setPrecio(i, f.clave + '|anual', $any($event.target).value)" /></td>
                    </tr>
                  }
                </tbody>
              </table>
              <button type="button" class="btn primary" (click)="guardarPlan(i)">Guardar {{ p.nombre }}</button>
            </section>
          }
        </div>
      }

      <!-- ============ NUEVO CLIENTE ============ -->
      @if (pestana() === 'nuevo') {
        <form class="form" (submit)="$event.preventDefault(); crearCliente()">
          <div class="grid2">
            <label>Tipo de cliente
              <select (change)="setTipoCliente($any($event.target).value)">
                <option value="empresa" [selected]="fTipo() === 'empresa'">Empresa</option>
                <option value="persona" [selected]="fTipo() === 'persona'">Persona natural</option>
              </select>
            </label>
            <label>{{ fTipo() === 'empresa' ? 'Razón social' : 'Nombre completo' }}
              <input [value]="fNombre()" (input)="fNombre.set($any($event.target).value)" />
            </label>
            <label>Documento
              <select (change)="fDocTipo.set($any($event.target).value)">
                @if (fTipo() === 'empresa') {
                  <option value="RUC" selected>RUC</option>
                } @else {
                  <option value="DNI" [selected]="fDocTipo() === 'DNI'">DNI</option>
                  <option value="CE" [selected]="fDocTipo() === 'CE'">Carné de extranjería</option>
                  <option value="PASAPORTE" [selected]="fDocTipo() === 'PASAPORTE'">Pasaporte</option>
                }
              </select>
            </label>
            <label>Número
              <input [value]="fDocNum()" (input)="fDocNum.set($any($event.target).value)" />
            </label>
            <label>Correo
              <input type="email" [value]="fCorreo()" (input)="fCorreo.set($any($event.target).value)" />
            </label>
            <label>Usuario de acceso
              <input autocomplete="off" [value]="fUsuario()" (input)="fUsuario.set($any($event.target).value)" />
            </label>
            <label>Clave inicial
              <input type="password" autocomplete="new-password" [value]="fClave()" (input)="fClave.set($any($event.target).value)" />
              <small>Mínimo 10 caracteres, con letras y números.</small>
            </label>
            @if (fTipo() === 'empresa') {
              <label>Cupo de usuarios
                <input type="number" min="1" [value]="fCupo()" (input)="fCupo.set($any($event.target).value)" />
                <small>Incluye al administrador. Vacío = 3.</small>
              </label>
            }
          </div>

          <h4>Paquetes</h4>
          <div class="subs-form">
            @for (s of fSubs(); track s.codigo; let i = $index) {
              <div class="sub-fila">
                <label class="chk">
                  <input type="checkbox" [checked]="s.marcado" (change)="setSub(i, { marcado: $any($event.target).checked })" />
                  {{ s.nombre }}
                </label>
                <select [disabled]="!s.marcado" (change)="setSub(i, { modo: $any($event.target).value })">
                  <option value="ver" [selected]="s.modo === 'ver'">Solo visualizar</option>
                  <option value="cotizar" [selected]="s.modo === 'cotizar'">Cotizar</option>
                </select>
                <select [disabled]="!s.marcado" (change)="setSub(i, { periodo: $any($event.target).value })">
                  <option value="mensual" [selected]="s.periodo === 'mensual'">Mensual</option>
                  <option value="anual" [selected]="s.periodo === 'anual'">Anual</option>
                </select>
              </div>
            }
          </div>

          <button type="submit" class="btn primary" [disabled]="guardando()">
            {{ guardando() ? 'Creando…' : 'Crear cliente' }}
          </button>
        </form>
      }
    </div>
  `,
  styles: [ESTILOS_ADMIN],
})
export class PlataformaPage implements OnInit {
  private readonly api: PlataformaService = inject(PlataformaService);
  readonly filas = FILAS;

  readonly pestana = signal<Pestana>('clientes');
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');
  readonly guardando = signal<boolean>(false);

  readonly resumen = signal<Resumen | null>(null);
  readonly empresas = signal<EmpresaFila[]>([]);
  readonly filtroTipo = signal<'' | 'empresa' | 'persona'>('');
  readonly planes = signal<PlanFila[]>([]);
  readonly planesEdit = signal<PlanEdit[]>([]);

  // renovar / agregar suscripción a un cliente existente
  readonly renovando = signal<number | null>(null);
  readonly rPlan = signal<string>('');
  readonly rModo = signal<Modo>('cotizar');
  readonly rPeriodo = signal<Periodo>('mensual');

  // formulario de cliente nuevo
  readonly fTipo = signal<'empresa' | 'persona'>('empresa');
  readonly fNombre = signal<string>('');
  readonly fDocTipo = signal<string>('RUC');
  readonly fDocNum = signal<string>('');
  readonly fCorreo = signal<string>('');
  readonly fUsuario = signal<string>('');
  readonly fClave = signal<string>('');
  readonly fCupo = signal<string>('');
  readonly fSubs = signal<SubForm[]>([]);

  ngOnInit(): void {
    this.cargarPlanes();
    this.cargarClientes();
  }

  irA(p: Pestana): void { this.pestana.set(p); this.limpiarAvisos(); }
  private limpiarAvisos(): void { this.mensaje.set(''); this.error.set(''); }
  private ok(t: string): void { this.error.set(''); this.mensaje.set(t); }
  private fallo(e: HttpErrorResponse): void { this.mensaje.set(''); this.error.set(this.msg(e)); }

  // ---------- Clientes ----------
  cargarClientes(): void {
    this.api.resumen().subscribe({ next: (r) => this.resumen.set(r), error: (e: HttpErrorResponse) => this.fallo(e) });
    this.api.empresas(this.filtroTipo()).subscribe({
      next: (l) => this.empresas.set(l),
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  setTipo(t: '' | 'empresa' | 'persona'): void { this.filtroTipo.set(t); this.cargarClientes(); }

  fecha(iso: string): string {
    return new Date(iso).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  proximo(s: SuscripcionFila): boolean {
    if (!s.vigente || s.estado !== 'activa') return false;
    return new Date(s.vence_en).getTime() - Date.now() < 30 * 86_400_000;
  }

  abrirRenovar(e: EmpresaFila): void {
    this.renovando.set(this.renovando() === e.id ? null : e.id);
    this.rPlan.set(this.planes()[0]?.codigo ?? '');
    this.rModo.set('cotizar');
    this.rPeriodo.set('mensual');
  }

  renovar(e: EmpresaFila): void {
    this.api.suscribir(e.id, { plan: this.rPlan(), modo: this.rModo(), periodo: this.rPeriodo() }).subscribe({
      next: () => { this.ok('Suscripción actualizada'); this.renovando.set(null); this.cargarClientes(); },
      error: (er: HttpErrorResponse) => this.fallo(er),
    });
  }

  cancelarSub(s: SuscripcionFila): void {
    if (!confirm(`¿Cancelar ${s.nombre}? El cliente perderá el acceso de inmediato.`)) return;
    this.api.editarSuscripcion(s.id, { estado: 'cancelada' }).subscribe({
      next: () => { this.ok('Suscripción cancelada'); this.cargarClientes(); },
      error: (er: HttpErrorResponse) => this.fallo(er),
    });
  }

  alternarEmpresa(e: EmpresaFila): void {
    const accion = e.activo ? 'suspender' : 'activar';
    if (!confirm(`¿Seguro que quieres ${accion} a ${e.nombre}?`)) return;
    this.api.editarEmpresa(e.id, { activo: !e.activo }).subscribe({
      next: () => { this.ok('Cliente actualizado'); this.cargarClientes(); },
      error: (er: HttpErrorResponse) => this.fallo(er),
    });
  }

  cambiarCupo(e: EmpresaFila): void {
    const v = prompt(`Cupo de usuarios para ${e.nombre} (incluye al administrador):`, String(e.cupo_usuarios));
    if (v === null) return;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) { this.error.set('El cupo debe ser un número entero mayor a 0'); return; }
    this.api.editarEmpresa(e.id, { cupo_usuarios: n }).subscribe({
      next: () => { this.ok('Cupo actualizado'); this.cargarClientes(); },
      error: (er: HttpErrorResponse) => this.fallo(er),
    });
  }

  // ---------- Paquetes y precios ----------
  cargarPlanes(): void {
    this.api.planes().subscribe({
      next: (ps) => {
        this.planes.set(ps);
        this.planesEdit.set(ps.map((p) => ({
          id: p.id, codigo: p.codigo, nombre: p.nombre, descripcion: p.descripcion, en_venta: p.en_venta,
          precios: Object.fromEntries(
            p.precios.map((x) => [`${x.tipo_cuenta}|${x.concepto}|${x.periodo}`, String(x.monto)])),
        })));
        if (!this.fSubs().length) {
          this.fSubs.set(ps.map((p) => ({
            codigo: p.codigo, nombre: p.nombre, marcado: false, modo: 'cotizar', periodo: 'mensual',
          })));
        }
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  setPlan(i: number, campo: 'nombre' | 'descripcion', v: string): void {
    this.planesEdit.update((l) => l.map((p, j) => (j === i ? ({ ...p, [campo]: v } as PlanEdit) : p)));
  }

  setEnVenta(i: number, v: boolean): void {
    this.planesEdit.update((l) => l.map((p, j) => (j === i ? { ...p, en_venta: v } : p)));
  }

  setPrecio(i: number, clave: string, v: string): void {
    this.planesEdit.update((l) => l.map((p, j) => (j === i ? { ...p, precios: { ...p.precios, [clave]: v } } : p)));
  }

  guardarPlan(i: number): void {
    const p = this.planesEdit()[i];
    const precios: PrecioFila[] = [];
    for (const f of FILAS) {
      for (const periodo of ['mensual', 'anual']) {
        const v = p.precios[`${f.clave}|${periodo}`];
        if (v !== undefined && v !== '' && !isNaN(Number(v)) && Number(v) >= 0) {
          const [tipo_cuenta, concepto] = f.clave.split('|');
          precios.push({ tipo_cuenta, concepto, periodo, monto: Number(v) });
        }
      }
    }
    this.api.editarPlan(p.id, { nombre: p.nombre, descripcion: p.descripcion, en_venta: p.en_venta })
      .pipe(switchMap(() => this.api.fijarPrecios(p.id, precios)))
      .subscribe({
        next: () => { this.ok(`${p.nombre} guardado`); this.cargarPlanes(); },
        error: (e: HttpErrorResponse) => this.fallo(e),
      });
  }

  // ---------- Nuevo cliente ----------
  setTipoCliente(t: 'empresa' | 'persona'): void {
    this.fTipo.set(t);
    this.fDocTipo.set(t === 'empresa' ? 'RUC' : 'DNI');
  }

  setSub(i: number, cambio: Partial<SubForm>): void {
    this.fSubs.update((l) => l.map((s, j) => (j === i ? { ...s, ...cambio } : s)));
  }

  crearCliente(): void {
    if (this.guardando()) return;
    const subs = this.fSubs().filter((s) => s.marcado).map((s) => ({ plan: s.codigo, modo: s.modo, periodo: s.periodo }));
    if (!subs.length) { this.mensaje.set(''); this.error.set('Marca al menos un paquete'); return; }
    this.guardando.set(true);
    this.api.crearCliente({
      tipo: this.fTipo(), nombre: this.fNombre().trim(), doc_tipo: this.fDocTipo(), doc_numero: this.fDocNum().trim(),
      correo: this.fCorreo().trim(), usuario: this.fUsuario().trim(), clave: this.fClave(),
      cupo_usuarios: this.fTipo() === 'empresa' && this.fCupo() ? Number(this.fCupo()) : null,
      suscripciones: subs,
    }).subscribe({
      next: () => {
        this.guardando.set(false);
        this.ok('Cliente creado');
        this.fNombre.set(''); this.fDocNum.set(''); this.fCorreo.set(''); this.fUsuario.set('');
        this.fClave.set(''); this.fCupo.set('');
        this.fSubs.update((l) => l.map((s) => ({ ...s, marcado: false })));
        this.pestana.set('clientes');
        this.cargarClientes();
      },
      error: (e: HttpErrorResponse) => { this.guardando.set(false); this.fallo(e); },
    });
  }

  private msg(e: HttpErrorResponse): string {
    const d = e.error?.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return 'Revisa los datos: hay campos vacíos o con formato inválido.';
    return 'No se pudo conectar con el servidor';
  }
}