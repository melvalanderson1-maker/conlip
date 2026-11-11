import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { CarritoService } from '../../core/carrito.service';
import { CheckoutService, OrdenCreada, ResultadoPago } from './checkout.service';
import { CatalogoPub, PublicoService } from './publico.service';
import { firstValueFrom } from 'rxjs';
import { pagarConCulqi } from './culqi';

interface CulqiApi {
  publicKey: string;
  settings(o: Record<string, unknown>): void;
  options(o: Record<string, unknown>): void;
  open(): void;
  close(): void;
  token?: { id: string };
  error?: { user_message?: string };
}
interface CulqiWindow { Culqi?: CulqiApi; culqi?: () => void; }

import { PedidoWhatsappComponent } from './pedido-whatsapp.component';

@Component({
  selector: 'app-checkout',
  imports: [
    PedidoWhatsappComponent,RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <a routerLink="/" class="volver">← Volver a los planes</a>
      <h1>Finaliza tu compra</h1>

      @if (!cat()) {
        <p class="muted">Cargando…</p>
      } @else if (paso() === 'listo') {
        <section class="listo">
          <div class="check">✓</div>
          <h2>{{ resultado()?.mensaje }}</h2>
          @if (resultado()?.cuenta_creada) {
            <p class="muted">Revisa tu bandeja de entrada (y la carpeta de spam). El enlace sirve una sola vez y vence en 24 horas.</p>
          }
          <a routerLink="/login" class="btn primary">Ir a iniciar sesión</a>
        </section>
      } @else if (resumen().lineas.length === 0) {
        <section class="vacio">
          <h2>Tu carrito está vacío</h2>
          <a routerLink="/" class="btn primary">Elegir paquetes</a>
        </section>
      } @else {
        <div class="cols">
          <section class="panel">
            @if (paso() === 'datos') {
              <h2>1. Tus datos</h2>
              <div class="seg">
                <button type="button" [class.on]="carrito.tipo() === 'persona'" (click)="setTipo('persona')">Persona natural</button>
                <button type="button" [class.on]="carrito.tipo() === 'empresa'" (click)="setTipo('empresa')">Empresa</button>
              </div>
              <div class="grid2">
                <label class="full">{{ carrito.tipo() === 'empresa' ? 'Razón social' : 'Nombres y apellidos' }}
                  <input autocomplete="name" [value]="nombre()" (input)="nombre.set($any($event.target).value)" />
                </label>
                <label>Tipo de documento
                  <select (change)="docTipo.set($any($event.target).value)">
                    @if (carrito.tipo() === 'empresa') {
                      <option value="RUC" selected>RUC</option>
                    } @else {
                      <option value="DNI" [selected]="docTipo() === 'DNI'">DNI</option>
                      <option value="CE" [selected]="docTipo() === 'CE'">Carné de extranjería</option>
                      <option value="PASAPORTE" [selected]="docTipo() === 'PASAPORTE'">Pasaporte</option>
                    }
                  </select>
                </label>
                <label>Número de documento
                  <input inputmode="numeric" [value]="docNum()" (input)="docNum.set($any($event.target).value)" />
                </label>
                <label>Correo electrónico
                  <input type="email" autocomplete="email" [value]="correo()" (input)="correo.set($any($event.target).value)" />
                  <small>Será tu usuario. Aquí te enviaremos el enlace para crear tu clave.</small>
                </label>
                <label>Teléfono / WhatsApp (opcional)
                  <input type="tel" autocomplete="tel" [value]="telefono()" (input)="telefono.set($any($event.target).value)" />
                </label>
              </div>
              <label class="chk">
                <input type="checkbox" [checked]="acepto()" (change)="acepto.set($any($event.target).checked)" />
                Acepto los <a href="/terminos" target="_blank" rel="noopener">términos y condiciones</a> y la
                <a href="/privacidad" target="_blank" rel="noopener">política de privacidad</a>.
              </label>
              @if (error()) { <p class="error">{{ error() }}</p> }
              <button type="button" class="btn primary lg" [disabled]="procesando() || !resumen().ok" (click)="continuar()">
                {{ procesando() ? 'Preparando…' : 'Continuar al pago' }}
              </button>
            }

            @if (paso() === 'pago' && orden(); as o) {
              <h2>2. Pago</h2>
              <p class="total">Total a pagar: <b>{{ soles(o.total) }}</b></p>
              @if (o.pago.proveedor === 'whatsapp') {
                  <app-pedido-whatsapp [codigo]="o.pago.codigo ?? ''" [url]="o.pago.whatsapp_url ?? ''" [orden]="o.orden_id" />
                } @else if (o.pago.proveedor === 'demo') {
                <p class="demo">Modo de prueba: no se cobra nada. Sirve para ver todo el flujo.</p>
                <div class="fila">
                  <button type="button" class="btn primary lg" [disabled]="procesando()" (click)="pagarDemo(false)">Pagar (demo)</button>
                  <button type="button" class="btn lg" [disabled]="procesando()" (click)="pagarDemo(true)">Simular pago rechazado</button>
                </div>
              } @else {
                <button type="button" class="btn primary lg" [disabled]="procesando()" (click)="pagarCulqi(o)">Pagar con tarjeta</button>
              }
              @if (error()) { <p class="error">{{ error() }}</p> }
              <button type="button" class="link" (click)="volverADatos()">← Editar mis datos</button>
            }
          </section>

          <aside class="resumen">
            <h3>Tu pedido</h3>
            <div class="seg chico">
              <button type="button" [class.on]="carrito.periodo() === 'mensual'" [disabled]="paso() !== 'datos'" (click)="carrito.periodo.set('mensual')">Mensual</button>
              <button type="button" [class.on]="carrito.periodo() === 'anual'" [disabled]="paso() !== 'datos'" (click)="carrito.periodo.set('anual')">Anual</button>
            </div>
            <ul class="lineas">
              @for (l of resumen().lineas; track l.clave) {
                <li>
                  <span>{{ l.texto }}</span>
                  <span class="monto">{{ l.monto === null ? 'No disponible' : soles(l.monto) }}</span>
                  @if (paso() === 'datos' && l.tipo !== 'extra') {
                    <button type="button" class="x" title="Quitar" (click)="quitar(l.tipo, l.id)">×</button>
                  }
                </li>
              }
            </ul>
            @if (carrito.tipo() === 'empresa' && paso() === 'datos') {
              <label class="extras">Usuarios adicionales
                <input type="number" min="0" max="200" [value]="carrito.extras()" (input)="setExtras($any($event.target).value)" />
              </label>
            }
            @if (!resumen().ok) {
              <p class="error">Algún elemento no está disponible para {{ carrito.tipo() === 'empresa' ? 'empresas' : 'personas' }} en este periodo. Quítalo o cambia la modalidad.</p>
            }
            <div class="tot"><span>Total estimado</span><b>{{ soles(resumen().total) }}</b></div>
            <small class="muted">El monto final lo confirma el sistema al continuar.</small>
          </aside>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; background: #f8f9fc; color: #0f172a;
      font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; --brand: #4f46e5; --line: #e6e8f0; --muted: #64748b; }
    * { box-sizing: border-box; }
    .wrap { max-width: 1060px; margin: 0 auto; padding: 24px 20px 60px; }
    .volver { color: var(--muted); text-decoration: none; font-size: .9rem; } h1 { margin: 10px 0 20px; letter-spacing: -.02em; }
    .muted { color: var(--muted); } .cols { display: grid; grid-template-columns: 1.4fr 1fr; gap: 22px; align-items: start; }
    .panel, .resumen { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 22px; }
    .resumen { position: sticky; top: 16px; } h2 { margin: 0 0 14px; font-size: 1.15rem; } h3 { margin: 0 0 12px; }
    .seg { display: inline-flex; padding: 4px; background: #eceef5; border-radius: 12px; margin-bottom: 14px; }
    .seg button { border: 0; background: none; padding: 8px 16px; border-radius: 9px; font: inherit; font-weight: 600; color: var(--muted); cursor: pointer; }
    .seg button.on { background: #fff; color: #0f172a; box-shadow: 0 1px 3px rgb(15 23 42 / .12); } .seg button:disabled { opacity: .6; cursor: default; }
    .seg.chico button { padding: 6px 12px; font-size: .85rem; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; } .full { grid-column: 1 / -1; }
    label { display: flex; flex-direction: column; gap: 6px; font-size: .85rem; font-weight: 600; } label small { font-weight: 400; color: var(--muted); }
    input:not([type=checkbox]), select { height: 42px; padding: 0 12px; border: 1px solid #cbd5e1; border-radius: 10px; font: inherit; font-weight: 400; background: #fff; }
    .chk { flex-direction: row; align-items: flex-start; gap: 8px; font-weight: 400; margin: 6px 0 14px; }
    .btn { display: inline-flex; align-items: center; justify-content: center; height: 40px; padding: 0 18px; border-radius: 12px; border: 1px solid var(--line);
      background: #fff; color: #0f172a; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
    .btn.primary { background: var(--brand); border-color: var(--brand); color: #fff; } .btn.lg { height: 48px; padding: 0 24px; }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    .link { border: 0; background: none; color: var(--muted); font: inherit; cursor: pointer; margin-top: 14px; padding: 0; }
    .error { padding: 10px 14px; border-radius: 10px; background: #fef2f2; color: #b91c1c; font-size: .88rem; }
    .demo { padding: 10px 14px; border-radius: 10px; background: #fef3c7; color: #92400e; font-size: .88rem; }
    .total { font-size: 1.1rem; } .fila { display: flex; gap: 10px; flex-wrap: wrap; }
    .lineas { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .lineas li { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: start; font-size: .9rem; }
    .monto { font-weight: 600; white-space: nowrap; }
    .x { border: 0; background: none; color: var(--muted); font-size: 1.1rem; line-height: 1; cursor: pointer; padding: 0 2px; }
    .extras { margin: 6px 0 12px; } .tot { display: flex; justify-content: space-between; padding-top: 12px; border-top: 1px solid var(--line); font-size: 1.1rem; }
    .listo, .vacio { max-width: 520px; margin: 40px auto; text-align: center; background: #fff; border: 1px solid var(--line); border-radius: 18px; padding: 36px; }
    .check { display: grid; place-items: center; width: 64px; height: 64px; margin: 0 auto 16px; border-radius: 50%; background: #d1fae5; color: #047857; font-size: 2rem; }
    @media (max-width: 820px) { .cols { grid-template-columns: 1fr; } .resumen { position: static; order: -1; } .grid2 { grid-template-columns: 1fr; } }
  `],
})
export class CheckoutPage implements OnInit {
  private readonly publico: PublicoService = inject(PublicoService);
  private readonly api: CheckoutService = inject(CheckoutService);
  readonly carrito: CarritoService = inject(CarritoService);

  readonly cat = signal<CatalogoPub | null>(null);
  readonly paso = signal<'datos' | 'pago' | 'listo'>('datos');
  readonly orden = signal<OrdenCreada | null>(null);
  readonly resultado = signal<ResultadoPago | null>(null);
  readonly procesando = signal<boolean>(false);
  readonly error = signal<string>('');

  readonly nombre = signal<string>('');
  readonly docTipo = signal<string>('DNI');
  readonly docNum = signal<string>('');
  readonly correo = signal<string>('');
  readonly telefono = signal<string>('');
  readonly acepto = signal<boolean>(false);

  readonly resumen = computed(() => {
    const c = this.cat();
    return c ? this.carrito.resumen(c) : { lineas: [], total: 0, ok: false };
  });

  ngOnInit(): void {
    this.docTipo.set(this.carrito.tipo() === 'empresa' ? 'RUC' : 'DNI');
    this.publico.catalogo().subscribe({
      next: (c) => this.cat.set(c),
      error: () => this.error.set('No pudimos cargar la información. Intenta de nuevo.'),
    });
  }

  soles(n: number): string {
    return 'S/ ' + n.toLocaleString('es-PE', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }

  setTipo(t: 'persona' | 'empresa'): void {
    this.carrito.tipo.set(t);
    this.docTipo.set(t === 'empresa' ? 'RUC' : 'DNI');
    if (t === 'persona') this.carrito.extras.set(0);
  }

  setExtras(v: string): void {
    const n = Math.floor(Number(v));
    this.carrito.extras.set(Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 0);
  }

  quitar(tipo: string, id: number): void {
    if (tipo === 'plan') this.carrito.quitarPlan(id);
    else if (tipo === 'servicio') this.carrito.quitarServicio(id);
  }

  continuar(): void {
    this.error.set('');
    if (!this.nombre().trim() || !this.docNum().trim() || !this.correo().trim()) {
      this.error.set('Completa nombre, documento y correo'); return;
    }
    if (!this.acepto()) { this.error.set('Debes aceptar los términos y la política de privacidad'); return; }
    this.procesando.set(true);
    this.api.crearOrden({
      tipo_cuenta: this.carrito.tipo(), periodo: this.carrito.periodo(),
      planes: this.carrito.planes(), servicios: this.carrito.servicios(),
      usuarios_extra: this.carrito.tipo() === 'empresa' ? this.carrito.extras() : 0,
      comprador: {
        nombre: this.nombre().trim(), doc_tipo: this.docTipo(), doc_numero: this.docNum().trim(),
        correo: this.correo().trim(), telefono: this.telefono().trim(),
      },
      acepto_terminos: this.acepto(),
    }).subscribe({
      next: (o) => { this.procesando.set(false); this.orden.set(o); this.paso.set('pago'); },
      error: (e: HttpErrorResponse) => { this.procesando.set(false); this.error.set(this.msg(e)); },
    });
  }

  volverADatos(): void { this.error.set(''); this.orden.set(null); this.paso.set('datos'); }

  pagarDemo(rechazar: boolean): void {
    this.enviarPago(rechazar ? { simular: 'rechazado' } : {});
  }

  private enviarPago(datos: { token?: string; simular?: string }): void {
    const o = this.orden();
    if (!o || this.procesando()) return;
    this.procesando.set(true);
    this.error.set('');
    this.api.pagar(o.orden_id, datos).subscribe({
      next: (r) => {
        this.procesando.set(false);
        this.resultado.set(r);
        this.carrito.vaciar();
        this.paso.set('listo');
      },
      error: (e: HttpErrorResponse) => { this.procesando.set(false); this.error.set(this.msg(e)); },
    });
  }

  // ---- Culqi: Custom Checkout + 3D Secure (se activa con PAGO_PROVEEDOR=culqi) ----
  async pagarCulqi(o: OrdenCreada): Promise<void> {
    if (this.procesando()) return;
    this.error.set('');
    try {
      const r = await pagarConCulqi(
        { total: o.total, moneda: o.moneda, llave: o.pago.llave_publica ?? '', correo: this.correo().trim() },
        (d) => firstValueFrom(this.api.pagar(o.orden_id, d)),
        (v) => this.procesando.set(v),
      );
      this.resultado.set(r);
      this.carrito.vaciar();
      this.paso.set('listo');
    } catch (e) {
      this.error.set(e instanceof HttpErrorResponse ? this.msg(e) : (e instanceof Error ? e.message : 'No se pudo procesar el pago'));
    }
  }

  private msg(e: HttpErrorResponse): string {
    const d = e.error?.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return 'Revisa los datos: hay campos vacíos o con formato inválido (correo, documento).';
    return 'No se pudo conectar con el servidor';
  }
}