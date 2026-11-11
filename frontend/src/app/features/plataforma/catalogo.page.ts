import { ChangeDetectionStrategy, Component, OnInit, WritableSignal, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable, forkJoin } from 'rxjs';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import {
  Beneficio, CatalogoService, Config, Modulo, PlanCat, PrecioFila, ServicioCat, TipoBeneficio,
} from './catalogo.service';

type Pestana = 'planes' | 'beneficios' | 'servicios' | 'sitio';
type PlanEdit = PlanCat & { precioStr: Record<string, string | undefined>; valores: Record<string, string> };
type ServEdit = ServicioCat & { entTxt: string; precioTxt: string };

const MODULOS: { id: Modulo; label: string }[] = [
  { id: 'perucompras', label: 'Perú Compras' },
  { id: 'mayor', label: 'Contratos Mayores (SEACE)' },
  { id: 'menor', label: 'Contratos Menores' },
];
const FILAS = [
  { clave: 'persona|ver', label: 'Persona · Solo visualizar' },
  { clave: 'persona|cotizar', label: 'Persona · Visualizar y cotizar' },
  { clave: 'empresa|ver', label: 'Empresa · Solo visualizar' },
  { clave: 'empresa|cotizar', label: 'Empresa · Visualizar y cotizar' },
  { clave: 'empresa|usuario_extra', label: 'Empresa · Usuario extra' },
];

@Component({
  selector: 'app-catalogo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <header class="cab">
        <div>
          <span class="eyebrow">Administración</span>
          <h2>Catálogo</h2>
          <p class="sub">Todo lo que se muestra y vende en la página pública se configura aquí. Los cambios se ven al instante en la portada.</p>
        </div>
      </header>

      <div class="tabs">
        <button type="button" [class.on]="pestana() === 'planes'" (click)="irA('planes')">Planes</button>
        <button type="button" [class.on]="pestana() === 'beneficios'" (click)="irA('beneficios')">Beneficios</button>
        <button type="button" [class.on]="pestana() === 'servicios'" (click)="irA('servicios')">Servicios</button>
        <button type="button" [class.on]="pestana() === 'sitio'" (click)="irA('sitio')">Sitio y contacto</button>
      </div>

      @if (mensaje()) { <p class="ok">{{ mensaje() }}</p> }
      @if (error()) { <p class="error">{{ error() }}</p> }

      <!-- ================= PLANES ================= -->
      @if (pestana() === 'planes') {
        <section class="card nuevo">
          <h4>Nuevo plan</h4>
          <div class="fila">
            <input class="grande" placeholder="Nombre del plan" [value]="npNombre()" (input)="npNombre.set($any($event.target).value)" />
            @for (m of modulos; track m.id) {
              <label class="chk">
                <input type="checkbox" [checked]="npModulos().includes(m.id)" (change)="toggleNuevoModulo(m.id, $any($event.target).checked)" />
                {{ m.label }}
              </label>
            }
            <button type="button" class="btn primary" (click)="crearPlan()">Crear plan</button>
          </div>
        </section>

        @for (p of planes(); track p.id; let i = $index) {
          <section class="card">
            <div class="fila">
              <input class="grande" [value]="p.nombre" (input)="p.nombre = $any($event.target).value" placeholder="Nombre del plan" />
              <label class="chk"><input type="checkbox" [checked]="p.en_venta" (change)="p.en_venta = $any($event.target).checked" /> En venta</label>
              <label class="chk"><input type="checkbox" [checked]="p.destacado" (change)="p.destacado = $any($event.target).checked" /> Recomendado</label>
              <span class="cod">{{ p.codigo }}</span>
            </div>
            <input [value]="p.subtitulo" (input)="p.subtitulo = $any($event.target).value" placeholder="Frase corta debajo del nombre" />
            <textarea rows="2" [value]="p.descripcion" (input)="p.descripcion = $any($event.target).value" placeholder="Descripción interna"></textarea>

            <div class="fila">
              <label class="num">Usuarios incluidos (empresa)
                <input type="number" min="1" [value]="p.usuarios_incluidos" (input)="p.usuarios_incluidos = aNumero($any($event.target).value, 3)" />
              </label>
              <div class="mods">
                <b>Módulos que habilita:</b>
                @for (m of modulos; track m.id) {
                  <label class="chk">
                    <input type="checkbox" [checked]="p.modulos.includes(m.id)" (change)="toggleModulo(p, m.id, $any($event.target).checked)" />
                    {{ m.label }}
                  </label>
                }
              </div>
            </div>

            <div class="dos">
              <div>
                <h5>Precios (S/) — vacío = no se vende</h5>
                <table class="mini">
                  <thead><tr><th>Concepto</th><th>Mensual</th><th>Anual</th></tr></thead>
                  <tbody>
                    @for (f of filas; track f.clave) {
                      <tr>
                        <td>{{ f.label }}</td>
                        <td><input type="number" min="0" step="0.01" [value]="p.precioStr[f.clave + '|mensual'] ?? ''"
                                   (input)="p.precioStr[f.clave + '|mensual'] = $any($event.target).value" /></td>
                        <td><input type="number" min="0" step="0.01" [value]="p.precioStr[f.clave + '|anual'] ?? ''"
                                   (input)="p.precioStr[f.clave + '|anual'] = $any($event.target).value" /></td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <div>
                <h5>Beneficios del plan</h5>
                <div class="benef">
                  @for (b of beneficios(); track b.id) {
                    <div class="b-fila">
                      <span>{{ b.nombre }}</span>
                      @if (b.tipo === 'check') {
                        <input type="checkbox" [checked]="!!val(p, b)" (change)="setVal(p, b, $any($event.target).checked ? 'x' : '')" />
                      } @else {
                        <input class="corto" [value]="val(p, b)" (input)="setVal(p, b, $any($event.target).value)"
                               [placeholder]="b.tipo === 'numero' ? 'Nº' : 'Texto'" />
                      }
                    </div>
                  }
                </div>
              </div>
            </div>

            <div class="fila acciones">
              <button type="button" class="btn primary" (click)="guardarPlan(p)">Guardar plan</button>
              <button type="button" class="btn" (click)="moverPlan(i, -1)" [disabled]="i === 0">↑ Subir</button>
              <button type="button" class="btn" (click)="moverPlan(i, 1)" [disabled]="i === planes().length - 1">↓ Bajar</button>
              <button type="button" class="btn peligro" (click)="borrarPlan(p)">Eliminar</button>
            </div>
          </section>
        } @empty {
          <p class="vacio">Aún no hay planes.</p>
        }
      }

      <!-- ================= BENEFICIOS ================= -->
      @if (pestana() === 'beneficios') {
        <p class="nota">Son las filas de la tabla comparativa. ✓ = incluido o no · Número y Texto muestran el valor de cada plan (por ejemplo "2" o "Todos").</p>
        <section class="card nuevo">
          <div class="fila">
            <input class="grande" placeholder="Nuevo beneficio" [value]="nbNombre()" (input)="nbNombre.set($any($event.target).value)" />
            <select (change)="nbTipo.set($any($event.target).value)">
              <option value="check" [selected]="nbTipo() === 'check'">Incluido (✓)</option>
              <option value="numero" [selected]="nbTipo() === 'numero'">Número</option>
              <option value="texto" [selected]="nbTipo() === 'texto'">Texto</option>
            </select>
            <button type="button" class="btn primary" (click)="crearBeneficio()">Agregar</button>
          </div>
        </section>
        @for (b of beneficios(); track b.id; let i = $index) {
          <section class="card">
            <div class="fila">
              <input class="grande" [value]="b.nombre" (input)="b.nombre = $any($event.target).value" />
              <select (change)="b.tipo = $any($event.target).value">
                <option value="check" [selected]="b.tipo === 'check'">Incluido (✓)</option>
                <option value="numero" [selected]="b.tipo === 'numero'">Número</option>
                <option value="texto" [selected]="b.tipo === 'texto'">Texto</option>
              </select>
              <label class="chk"><input type="checkbox" [checked]="b.visible" (change)="b.visible = $any($event.target).checked" /> Visible</label>
              <button type="button" class="btn primary" (click)="guardarBeneficio(b)">Guardar</button>
              <button type="button" class="btn" (click)="moverBeneficio(i, -1)" [disabled]="i === 0">↑</button>
              <button type="button" class="btn" (click)="moverBeneficio(i, 1)" [disabled]="i === beneficios().length - 1">↓</button>
              <button type="button" class="btn peligro" (click)="borrarBeneficio(b)">Eliminar</button>
            </div>
          </section>
        }
      }

      <!-- ================= SERVICIOS ================= -->
      @if (pestana() === 'servicios') {
        <p class="nota">Servicios personalizados y de capacitación que se muestran en la página pública. Precio vacío = "A cotizar".</p>
        <datalist id="cats">
          @for (c of categorias(); track c) { <option [value]="c"></option> }
        </datalist>
        <section class="card nuevo">
          <div class="fila">
            <input list="cats" class="grande" placeholder="Categoría (ej. Ingresa a Perú Compras)" [value]="nsCategoria()" (input)="nsCategoria.set($any($event.target).value)" />
            <select (change)="nsModulo.set($any($event.target).value)">
              <option value="" [selected]="nsModulo() === ''">General (sin paquete)</option>
              @for (m of modulos; track m.id) {
                <option [value]="m.id" [selected]="nsModulo() === m.id">{{ m.label }}</option>
              }
            </select>
            <input class="grande" placeholder="Nombre del servicio" [value]="nsNombre()" (input)="nsNombre.set($any($event.target).value)" />
            <button type="button" class="btn primary" (click)="crearServicio()">Agregar</button>
          </div>
        </section>
        @for (s of servicios(); track s.id; let i = $index) {
          <section class="card">
            <div class="fila">
              <input list="cats" class="grande" [value]="s.categoria" (input)="s.categoria = $any($event.target).value" placeholder="Categoría" />
              <input class="grande" [value]="s.nombre" (input)="s.nombre = $any($event.target).value" placeholder="Nombre" />
              <select (change)="s.modulo = $any($event.target).value || null">
                <option value="" [selected]="!s.modulo">General (sin paquete)</option>
                @for (m of modulos; track m.id) {
                  <option [value]="m.id" [selected]="s.modulo === m.id">{{ m.label }}</option>
                }
              </select>
              <label class="chk"><input type="checkbox" [checked]="s.activo" (change)="s.activo = $any($event.target).checked" /> Visible</label>
            </div>
            <input [value]="s.descripcion" (input)="s.descripcion = $any($event.target).value" placeholder="Descripción corta (opcional)" />
            <label class="num">Qué incluye (uno por línea)
              <textarea rows="5" [value]="s.entTxt" (input)="s.entTxt = $any($event.target).value"></textarea>
            </label>
            <div class="fila">
              <label class="num">Precio (S/) — vacío = A cotizar
                <input type="number" min="0" step="0.01" [value]="s.precioTxt" (input)="s.precioTxt = $any($event.target).value" />
              </label>
              <button type="button" class="btn primary" (click)="guardarServicio(s)">Guardar</button>
              <button type="button" class="btn" (click)="moverServicio(i, -1)" [disabled]="i === 0">↑</button>
              <button type="button" class="btn" (click)="moverServicio(i, 1)" [disabled]="i === servicios().length - 1">↓</button>
              <button type="button" class="btn peligro" (click)="borrarServicio(s)">Eliminar</button>
            </div>
          </section>
        }
      }

      <!-- ================= SITIO ================= -->
      @if (pestana() === 'sitio') {
        <section class="card">
          <label class="num">Nombre del sitio
            <input [value]="cfg('sitio_nombre')" (input)="setCfg('sitio_nombre', $any($event.target).value)" />
          </label>
          <label class="num">Título principal
            <input [value]="cfg('sitio_titular')" (input)="setCfg('sitio_titular', $any($event.target).value)" />
          </label>
          <label class="num">Texto debajo del título
            <textarea rows="3" [value]="cfg('sitio_subtitulo')" (input)="setCfg('sitio_subtitulo', $any($event.target).value)"></textarea>
          </label>
          <h4>Los 3 paquetes</h4>
          @for (m of modulos; track m.id) {
            <div class="fila">
              <label class="num grande">Nombre: {{ m.label }}
                <input [placeholder]="m.label" [value]="cfg('paq_' + m.id + '_nombre')"
                       (input)="setCfg('paq_' + m.id + '_nombre', $any($event.target).value)" />
              </label>
              <label class="num grande">Frase corta
                <input [value]="cfg('paq_' + m.id + '_desc')"
                       (input)="setCfg('paq_' + m.id + '_desc', $any($event.target).value)" />
              </label>
            </div>
          }
          <label class="num">WhatsApp de ventas (con código de país, ej. 51987654321)
            <input [value]="cfg('contacto_whatsapp')" (input)="setCfg('contacto_whatsapp', $any($event.target).value)" />
          </label>
          <label class="num">Correo de contacto
            <input type="email" [value]="cfg('contacto_correo')" (input)="setCfg('contacto_correo', $any($event.target).value)" />
          </label>
          <div class="fila"><button type="button" class="btn primary" (click)="guardarConfig()">Guardar sitio</button></div>
        </section>
      }
    </div>
  `,
  styles: [ESTILOS_ADMIN],
})
export class CatalogoPage implements OnInit {
  private readonly api: CatalogoService = inject(CatalogoService);
  readonly modulos = MODULOS;
  readonly filas = FILAS;

  readonly pestana = signal<Pestana>('planes');
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');

  readonly planes = signal<PlanEdit[]>([]);
  readonly beneficios = signal<Beneficio[]>([]);
  readonly servicios = signal<ServEdit[]>([]);
  readonly config = signal<Config>({});
  readonly categorias = computed<string[]>(() => [...new Set(this.servicios().map((s) => s.categoria))]);

  readonly npNombre = signal<string>('');
  readonly npModulos = signal<Modulo[]>([]);
  readonly nbNombre = signal<string>('');
  readonly nbTipo = signal<TipoBeneficio>('check');
  readonly nsCategoria = signal<string>('');
  readonly nsNombre = signal<string>('');
  readonly nsModulo = signal<string>('');

  ngOnInit(): void {
    this.cargarBeneficios();
    this.cargarPlanes();
    this.cargarServicios();
    this.api.config().subscribe({ next: (c) => this.config.set(c), error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  irA(p: Pestana): void { this.pestana.set(p); this.mensaje.set(''); this.error.set(''); }
  private ok(t: string): void { this.error.set(''); this.mensaje.set(t); }
  private fallo(e: HttpErrorResponse): void { this.mensaje.set(''); this.error.set(this.msg(e)); }
  aNumero(v: string, defecto: number): number { const n = Number(v); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : defecto; }

  // ---------------- Planes ----------------
  cargarPlanes(): void {
    this.api.planes().subscribe({
      next: (ps) => this.planes.set(ps.map((p) => ({
        ...p,
        precioStr: Object.fromEntries(p.precios.map((x) => [`${x.tipo_cuenta}|${x.concepto}|${x.periodo}`, String(x.monto)])),
        valores: { ...p.beneficios },
      }))),
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  toggleNuevoModulo(m: Modulo, on: boolean): void {
    this.npModulos.update((l) => (on ? [...new Set([...l, m])] : l.filter((x) => x !== m)));
  }

  crearPlan(): void {
    if (this.npNombre().trim().length < 2) { this.mensaje.set(''); this.error.set('Escribe el nombre del plan'); return; }
    if (!this.npModulos().length) { this.mensaje.set(''); this.error.set('Marca al menos un módulo'); return; }
    this.api.crearPlan({ nombre: this.npNombre().trim(), modulos: this.npModulos() }).subscribe({
      next: () => { this.ok('Plan creado'); this.npNombre.set(''); this.npModulos.set([]); this.cargarPlanes(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  toggleModulo(p: PlanEdit, m: Modulo, on: boolean): void {
    p.modulos = on ? [...new Set([...p.modulos, m])] : p.modulos.filter((x) => x !== m);
  }

  val(p: PlanEdit, b: Beneficio): string { return p.valores[String(b.id)] ?? ''; }
  setVal(p: PlanEdit, b: Beneficio, v: string): void { p.valores[String(b.id)] = v; }

  guardarPlan(p: PlanEdit): void {
    if (!p.modulos.length) { this.mensaje.set(''); this.error.set('Un plan necesita al menos un módulo'); return; }
    const precios: PrecioFila[] = [];
    for (const f of FILAS) {
      for (const periodo of ['mensual', 'anual']) {
        const v = p.precioStr[`${f.clave}|${periodo}`];
        if (v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0) {
          const [tipo_cuenta, concepto] = f.clave.split('|');
          precios.push({ tipo_cuenta, concepto, periodo, monto: Number(v) });
        }
      }
    }
    forkJoin([
      this.api.editarPlan(p.id, {
        nombre: p.nombre.trim(), subtitulo: p.subtitulo.trim(), descripcion: p.descripcion.trim(),
        en_venta: p.en_venta, destacado: p.destacado, usuarios_incluidos: p.usuarios_incluidos,
      }),
      this.api.fijarModulos(p.id, p.modulos),
      this.api.fijarPrecios(p.id, precios),
      this.api.fijarBeneficios(p.id, p.valores),
    ]).subscribe({
      next: () => this.ok(`"${p.nombre}" guardado`),
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  borrarPlan(p: PlanEdit): void {
    if (!confirm(`¿Eliminar el plan "${p.nombre}"? Esta acción no se puede deshacer.`)) return;
    this.api.borrarPlan(p.id).subscribe({
      next: () => { this.ok('Plan eliminado'); this.cargarPlanes(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  moverPlan(i: number, d: number): void { this.mover(this.planes, i, d, (ids) => this.api.ordenarPlanes(ids)); }

  // ---------------- Beneficios ----------------
  cargarBeneficios(): void {
    this.api.beneficios().subscribe({ next: (l) => this.beneficios.set(l), error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  crearBeneficio(): void {
    if (this.nbNombre().trim().length < 2) { this.mensaje.set(''); this.error.set('Escribe el nombre del beneficio'); return; }
    this.api.crearBeneficio({ nombre: this.nbNombre().trim(), tipo: this.nbTipo() }).subscribe({
      next: () => { this.ok('Beneficio agregado'); this.nbNombre.set(''); this.cargarBeneficios(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  guardarBeneficio(b: Beneficio): void {
    this.api.editarBeneficio(b.id, { nombre: b.nombre.trim(), tipo: b.tipo, visible: b.visible }).subscribe({
      next: () => this.ok('Beneficio guardado'),
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  borrarBeneficio(b: Beneficio): void {
    if (!confirm(`¿Eliminar "${b.nombre}"? Se quitará de todos los planes.`)) return;
    this.api.borrarBeneficio(b.id).subscribe({
      next: () => { this.ok('Beneficio eliminado'); this.cargarBeneficios(); this.cargarPlanes(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  moverBeneficio(i: number, d: number): void { this.mover(this.beneficios, i, d, (ids) => this.api.ordenarBeneficios(ids)); }

  // ---------------- Servicios ----------------
  cargarServicios(): void {
    this.api.servicios().subscribe({
      next: (l) => this.servicios.set(l.map((s) => ({
        ...s, entTxt: s.entregables.join('\n'), precioTxt: s.precio === null ? '' : String(s.precio),
      }))),
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  crearServicio(): void {
    if (this.nsCategoria().trim().length < 2 || this.nsNombre().trim().length < 2) {
      this.mensaje.set(''); this.error.set('Escribe la categoría y el nombre'); return;
    }
    this.api.crearServicio({
      categoria: this.nsCategoria().trim(), nombre: this.nsNombre().trim(), modulo: this.nsModulo() || null,
    }).subscribe({
      next: () => { this.ok('Servicio agregado'); this.nsNombre.set(''); this.cargarServicios(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  guardarServicio(s: ServEdit): void {
    const precio = s.precioTxt.trim();
    this.api.editarServicio(s.id, {
      categoria: s.categoria.trim(), nombre: s.nombre.trim(), descripcion: s.descripcion.trim(),
      entregables: s.entTxt.split('\n'), activo: s.activo,
      ...(s.modulo ? { modulo: s.modulo } : { sin_modulo: true }),
      ...(precio === '' ? { sin_precio: true } : { precio: Number(precio) }),
    }).subscribe({
      next: () => this.ok(`"${s.nombre}" guardado`),
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  borrarServicio(s: ServEdit): void {
    if (!confirm(`¿Eliminar el servicio "${s.nombre}"?`)) return;
    this.api.borrarServicio(s.id).subscribe({
      next: () => { this.ok('Servicio eliminado'); this.cargarServicios(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  moverServicio(i: number, d: number): void { this.mover(this.servicios, i, d, (ids) => this.api.ordenarServicios(ids)); }

  // ---------------- Sitio ----------------
  cfg(k: string): string { return this.config()[k] ?? ''; }
  setCfg(k: string, v: string): void { this.config.update((c) => ({ ...c, [k]: v })); }

  guardarConfig(): void {
    this.api.guardarConfig(this.config()).subscribe({
      next: () => this.ok('Sitio guardado'),
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  // ---------------- Utilidades ----------------
  private mover<T extends { id: number }>(
    sig: WritableSignal<T[]>, i: number, d: number, guardar: (ids: number[]) => Observable<unknown>,
  ): void {
    const l = [...sig()];
    const j = i + d;
    if (j < 0 || j >= l.length) return;
    [l[i], l[j]] = [l[j], l[i]];
    sig.set(l);
    guardar(l.map((x) => x.id)).subscribe({ error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  private msg(e: HttpErrorResponse): string {
    const d = e.error?.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return 'Revisa los datos: hay campos vacíos o con formato inválido.';
    return 'No se pudo conectar con el servidor';
  }
}