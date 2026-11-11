import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TiempoRealService } from '../../core/tiempo-real.service';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../../core/auth.service';
import { CarritoService, ModoPlan } from '../../core/carrito.service';
import { IconComponent } from '../../shared/icon.component';
import { OrdenCreada } from '../publico/checkout.service';
import { firstValueFrom } from 'rxjs';
import { pagarConCulqi } from '../publico/culqi';
import { CatalogoPub, PlanPub, PublicoService, ServicioPub } from '../publico/publico.service';
import { CuentaService, MiCuenta, SuscripcionCuenta } from './cuenta.service';
import { MisServiciosComponent } from './mis-servicios.component';

interface Modo { modo: ModoPlan; label: string; monto: number; }

const NOMBRE_MODULO: Record<string, string> = {
  perucompras: 'Perú Compras', mayor: 'Contratos Mayores', menor: 'Contratos Menores',
};
const ESTADO_PEDIDO: Record<string, string> = {
  nuevo: 'Recibido', en_curso: 'En curso', entregado: 'Entregado', cancelado: 'Cancelado',
};

import { PedidoWhatsappComponent } from '../publico/pedido-whatsapp.component';

@Component({
  selector: 'app-cuenta',
    imports: [PedidoWhatsappComponent, IconComponent, MisServiciosComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      @if (aviso()) {
        <p class="banner ok"><app-icon name="circle-check" [size]="18" /> {{ aviso() }}</p>
      }
      @if (error()) {
        <p class="banner bad"><app-icon name="alert" [size]="18" /> {{ error() }}</p>
      }

      @if (datos(); as d) {
        @let e = d.empresa;

        <header class="cab">
          <div class="ident">
            <span class="av"><app-icon [name]="esEmpresa() ? 'building' : 'user'" [size]="24" /></span>
            <div>
              <small class="eyebrow">Mi cuenta</small>
              <h1>{{ e.nombre }}</h1>
              <p>{{ e.doc_tipo }} {{ e.doc_numero }} · {{ e.correo }}</p>
            </div>
          </div>
          <span class="tag">{{ esEmpresa() ? 'Cuenta de empresa' : 'Persona natural' }}</span>
        </header>

        <div class="kpis">
          <div class="kpi">
            <span class="k-ico"><app-icon name="layers" [size]="18" /></span>
            <div><b>{{ activas().length }}</b><small>Suscripciones activas</small></div>
          </div>
          <div class="kpi">
            <span class="k-ico"><app-icon name="calendar" [size]="18" /></span>
            <div><b class="k-txt">{{ proximaTxt() }}</b><small>Próximo vencimiento</small></div>
          </div>
          @if (esEmpresa()) {
            <div class="kpi">
              <span class="k-ico"><app-icon name="users" [size]="18" /></span>
              <div><b>{{ e.usados }} / {{ e.cupo_efectivo }}</b><small>Usuarios en uso</small></div>
            </div>
          }
        </div>

        <!-- ================= SUSCRIPCIONES ================= -->
        <section class="bloque">
          <div class="b-cab"><h2>Mis suscripciones</h2></div>
          @if (!suscripciones().length) {
            <div class="vacio">
              <app-icon name="package" [size]="30" />
              <p>Aún no tienes suscripciones. Agrega un plan más abajo.</p>
            </div>
          }
          <div class="subs">
            @for (s of suscripciones(); track s.id) {
              @let dias = diasRestantes(s.vence_en);
              <article class="sub" [class.venc]="!s.vigente">
                <div class="sub-top">
                  <span class="s-ico"><app-icon name="package" [size]="20" /></span>
                  <div class="s-tit">
                    <h3>{{ s.nombre }}</h3>
                    <div class="mods">
                      @for (m of s.modulos; track m) { <span class="chip">{{ nombreModulo(m) }}</span> }
                    </div>
                  </div>
                  <span class="estado" [class.ok]="tono(s) === 'ok'" [class.warn]="tono(s) === 'warn'" [class.bad]="tono(s) === 'bad'">
                    {{ textoEstado(s) }}
                  </span>
                </div>
                <div class="meta">
                  <span>{{ s.modo === 'cotizar' ? 'Visualizar y cotizar' : 'Solo visualizar' }}</span>
                  <span>{{ s.periodo === 'anual' ? 'Anual' : 'Mensual' }}</span>
                </div>
                <div class="barra"><span [style.width.%]="progreso(s)"></span></div>
                <p class="vence">
                  @if (s.vigente) {
                    Vence el {{ fecha(s.vence_en) }} · quedan {{ dias }} {{ dias === 1 ? 'día' : 'días' }}
                  } @else {
                    Venció el {{ fecha(s.vence_en) }}
                  }
                </p>
                <div class="acciones">
                  @if (puedeRenovar(s)) {
                    <button type="button" class="btn" [class.sel]="enRenovar(s)" (click)="renovar(s)">
                      <app-icon [name]="enRenovar(s) ? 'check' : 'refresh'" [size]="15" />
                      {{ enRenovar(s) ? 'En tu pedido' : 'Renovar · ' + soles(precioSub(s, s.modo)) }}
                    </button>
                  } @else {
                    <small class="muted">Este plan ya no está a la venta. Escríbenos para renovarlo.</small>
                  }
                  @if (puedeMejorar(s)) {
                    <button type="button" class="btn alt" [class.sel]="enMejora(s)" (click)="mejorar(s)">
                      <app-icon [name]="enMejora(s) ? 'check' : 'arrow-up-right'" [size]="15" />
                      {{ enMejora(s) ? 'En tu pedido' : 'Mejorar a cotizar · ' + soles(precioSub(s, 'cotizar')) }}
                    </button>
                  }
                </div>
              </article>
            }
          </div>
        </section>

        <!-- ================= AMPLIAR ================= -->
        <section class="bloque">
          <div class="b-cab">
            <h2>Ampliar mi cuenta</h2>
            <div class="seg">
              <button type="button" [class.on]="carrito.periodo() === 'mensual'" (click)="carrito.periodo.set('mensual')">Mensual</button>
              <button type="button" [class.on]="carrito.periodo() === 'anual'" (click)="carrito.periodo.set('anual')">Anual</button>
            </div>
          </div>
          <p class="ayuda">Todo lo que elijas se paga junto, en un solo cobro, por el periodo seleccionado.</p>

          @if (disponibles().length) {
            <h3 class="sub-t">Planes disponibles</h3>
            <div class="grid">
              @for (p of disponibles(); track p.id) {
                <article class="plan">
                  <div class="p-top">
                    <span class="s-ico"><app-icon name="layers" [size]="18" /></span>
                    <div><h4>{{ p.nombre }}</h4><small>{{ p.subtitulo }}</small></div>
                  </div>
                  <div class="mods">
                    @for (m of p.modulos; track m) { <span class="chip">{{ nombreModulo(m) }}</span> }
                  </div>
                  @for (m of modos(p); track m.modo) {
                    <button type="button" class="opcion" [class.sel]="carrito.enCarrito(p.id, m.modo)" (click)="carrito.alternarPlan(p.id, m.modo)">
                      <span class="o-t">{{ m.label }}</span>
                      <span class="o-p">{{ soles(m.monto) }}<small>/{{ carrito.periodo() === 'anual' ? 'año' : 'mes' }}</small></span>
                      <app-icon [name]="carrito.enCarrito(p.id, m.modo) ? 'check' : 'plus'" [size]="16" />
                    </button>
                  }
                </article>
              }
            </div>
          }

          @if (serviciosVenta().length) {
            <h3 class="sub-t">Servicios personalizados</h3>
            <ul class="srv">
              @for (s of serviciosVenta(); track s.id) {
                <li>
                  <span class="s-ico"><app-icon name="file" [size]="18" /></span>
                  <div class="srv-t"><b>{{ s.nombre }}</b><small>{{ s.categoria }}</small></div>
                  <span class="o-p">{{ soles(s.precio ?? 0) }}</span>
                  <button type="button" class="btn" [class.sel]="carrito.servicios().includes(s.id)" (click)="carrito.alternarServicio(s.id)">
                    <app-icon [name]="carrito.servicios().includes(s.id) ? 'check' : 'plus'" [size]="15" />
                    {{ carrito.servicios().includes(s.id) ? 'Agregado' : 'Agregar' }}
                  </button>
                </li>
              }
            </ul>
          }

          @if (esEmpresa()) {
            <h3 class="sub-t">Usuarios adicionales</h3>
            <div class="extras">
              <div class="e-info">
                <span class="s-ico"><app-icon name="users" [size]="18" /></span>
                <div><b>Total de usuarios adicionales</b><small>{{ extrasTxt() }}</small></div>
              </div>
              <div class="step">
                <button type="button" aria-label="Quitar uno" [disabled]="carrito.extras() === 0" (click)="cambiarExtras(-1)">
                  <app-icon name="minus" [size]="16" />
                </button>
                <input type="number" min="0" max="200" [disabled]="precioExtraUnit() === 0" [value]="carrito.extras()"
                       (input)="setExtras($any($event.target).value)" />
                <button type="button" aria-label="Agregar uno" [disabled]="precioExtraUnit() === 0" (click)="cambiarExtras(1)">
                  <app-icon name="plus" [size]="16" />
                </button>
              </div>
            </div>
          }

          @if (!disponibles().length && !serviciosVenta().length && !esEmpresa()) {
            <p class="muted">Por ahora no hay nada más para agregar a tu cuenta.</p>
          }
        </section>

        <app-mis-servicios />

        <!-- ================= HISTORIAL ================= -->
        <section class="bloque">
          <h2>Historial</h2>
          <div class="dos">
            <div class="lista">
              <h3 class="sub-t"><app-icon name="receipt" [size]="16" /> Compras</h3>
              @for (o of d.ordenes; track o.id) {
                <div class="fila">
                  <div class="f-top"><b>{{ soles(o.total) }}</b><small>{{ fechaHora(o.pagado_en ?? o.creado_en) }}</small></div>
                  <ul>
                    @for (i of o.items; track $index) { <li>{{ i.descripcion }}</li> }
                  </ul>
                  @if (o.estado === 'error_aprovision') {
                    <small class="warn-t">Recibimos tu pago y estamos activándolo.</small>
                  }
                </div>
              } @empty {
                <p class="muted">Todavía no hay compras.</p>
              }
            </div>
            <div class="lista">
              <h3 class="sub-t"><app-icon name="inbox" [size]="16" /> Servicios solicitados</h3>
              @for (p of d.pedidos; track p.id) {
                <div class="fila">
                  <div class="f-top"><b>{{ p.servicio_nombre }}</b><span class="chip">{{ estadoPedido(p.estado) }}</span></div>
                  <small>{{ fechaHora(p.creado_en) }}</small>
                </div>
              } @empty {
                <p class="muted">Todavía no hay servicios solicitados.</p>
              }
            </div>
          </div>
        </section>
      } @else if (!error()) {
        <p class="muted cargando">Cargando tu cuenta…</p>
      }
    </div>

    <!-- ================= BARRA DEL PEDIDO ================= -->
    @if (carrito.cantidad() > 0 && !orden()) {
      <div class="pedido">
        <div class="p-info">
          <b>{{ carrito.cantidad() }}</b> {{ carrito.cantidad() === 1 ? 'elemento' : 'elementos' }}
          <span class="sep"></span>
          <b>{{ soles(resumen().total) }}</b>
          @if (!resumen().ok) { <small class="warn-t">Algún elemento no está disponible en este periodo</small> }
        </div>
        <button type="button" class="btn ghost" (click)="carrito.vaciar()">Vaciar</button>
        <button type="button" class="btn primary" [disabled]="procesando() || !resumen().ok" (click)="revisar()">
          <app-icon name="credit-card" [size]="16" /> {{ procesando() ? 'Preparando…' : 'Revisar y pagar' }}
        </button>
      </div>
    }

    <!-- ================= PAGO ================= -->
    @if (orden(); as o) {
      <div class="overlay" (click)="cancelarPago()">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Confirmar y pagar" (click)="$event.stopPropagation()">
          <header class="m-cab">
            <h3>Confirmar y pagar</h3>
            <button type="button" class="x" aria-label="Cerrar" (click)="cancelarPago()"><app-icon name="x" [size]="18" /></button>
          </header>
          <ul class="m-lineas">
            @for (i of o.items; track $index) {
              <li>
                <span>{{ i.descripcion }}@if (i.cantidad > 1) { × {{ i.cantidad }} }</span>
                <b>{{ soles(i.monto_unit * i.cantidad) }}</b>
              </li>
            }
          </ul>
          <div class="m-total"><span>Total a pagar</span><b>{{ soles(o.total) }}</b></div>

          @if (o.pago.proveedor === 'whatsapp') {
              <app-pedido-whatsapp [codigo]="o.pago.codigo ?? ''" [url]="o.pago.whatsapp_url ?? ''" [orden]="o.orden_id" />
            } @else if (o.pago.proveedor === 'demo') {
            <p class="demo"><app-icon name="alert" [size]="16" /> Modo de prueba: no se cobra nada.</p>
            <div class="m-botones">
              <button type="button" class="btn primary lg" [disabled]="procesando()" (click)="pagarDemo(false)">
                <app-icon name="credit-card" [size]="16" /> Pagar (demo)
              </button>
              <button type="button" class="btn lg" [disabled]="procesando()" (click)="pagarDemo(true)">Simular pago rechazado</button>
            </div>
          } @else {
            <button type="button" class="btn primary lg block" [disabled]="procesando()" (click)="pagarCulqi()">
              <app-icon name="credit-card" [size]="16" /> Pagar con tarjeta
            </button>
            <p class="seguro"><app-icon name="lock" [size]="14" /> Pago seguro. Los datos de tu tarjeta nunca pasan por nuestros servidores.</p>
          }
          @if (modalError()) { <p class="banner bad"><app-icon name="alert" [size]="16" /> {{ modalError() }}</p> }
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block; color: #0f172a; --brand: #4f46e5; --line: #e6e8f0; --muted: #64748b; --soft: #eef0ff; }
    * { box-sizing: border-box; }
    .wrap { max-width: 1060px; margin: 0 auto; padding: 24px 20px 120px; }
    .muted { color: var(--muted); font-size: .9rem; margin: 0; } .cargando { padding: 40px 0; text-align: center; }
    .banner { display: flex; align-items: center; gap: 10px; margin: 0 0 14px; padding: 12px 16px; border-radius: 12px; font-size: .9rem; }
    .banner.ok { background: #d1fae5; color: #047857; } .banner.bad { background: #fef2f2; color: #b91c1c; }
    .cab { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 18px; }
    .ident { display: flex; align-items: center; gap: 14px; }
    .av { display: grid; place-items: center; width: 52px; height: 52px; border-radius: 14px; background: var(--soft); color: var(--brand); }
    .eyebrow { display: block; font-size: .72rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
    h1 { margin: 2px 0 2px; font-size: 1.4rem; letter-spacing: -.02em; } .ident p { margin: 0; color: var(--muted); font-size: .88rem; }
    .tag { padding: 5px 12px; border-radius: 999px; background: var(--soft); color: var(--brand); font-size: .78rem; font-weight: 600; white-space: nowrap; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 8px; }
    .kpi { display: flex; align-items: center; gap: 14px; padding: 16px; background: #fff; border: 1px solid var(--line); border-radius: 16px; }
    .k-ico { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 12px; background: var(--soft); color: var(--brand); flex: none; }
    .kpi b { display: block; font-size: 1.35rem; letter-spacing: -.02em; } .kpi b.k-txt { font-size: .98rem; line-height: 1.3; }
    .kpi small { color: var(--muted); }
    .bloque { margin-top: 30px; } .bloque h2 { margin: 0; font-size: 1.15rem; }
    .b-cab { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
    .ayuda { margin: -4px 0 14px; color: var(--muted); font-size: .88rem; }
    .sub-t { display: flex; align-items: center; gap: 8px; margin: 22px 0 12px; font-size: .78rem; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); }
    .vacio { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 32px; color: var(--muted); background: #fff; border: 1px dashed #cbd5e1; border-radius: 16px; }
    .vacio p { margin: 0; }
    .subs, .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
    .sub, .plan { display: flex; flex-direction: column; gap: 12px; padding: 18px; background: #fff; border: 1px solid var(--line); border-radius: 16px; transition: .15s; }
    .sub:hover, .plan:hover { border-color: #c7cbe0; box-shadow: 0 12px 28px -18px rgb(79 70 229 / .35); } .sub.venc { background: #fffafa; }
    .sub-top, .p-top { display: flex; align-items: flex-start; gap: 12px; }
    .s-ico { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 11px; background: var(--soft); color: var(--brand); flex: none; }
    .s-tit { flex: 1; min-width: 0; } h3 { margin: 0 0 6px; font-size: 1rem; } h4 { margin: 0; font-size: .98rem; } .p-top small { color: var(--muted); }
    .mods { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip { padding: 2px 10px; border-radius: 999px; background: var(--soft); color: var(--brand); font-size: .72rem; font-weight: 600; }
    .estado { padding: 3px 10px; border-radius: 999px; font-size: .72rem; font-weight: 700; white-space: nowrap; }
    .estado.ok { background: #d1fae5; color: #047857; } .estado.warn { background: #fef3c7; color: #b45309; } .estado.bad { background: #fee2e2; color: #b91c1c; }
    .meta { display: flex; gap: 14px; color: var(--muted); font-size: .85rem; }
    .barra { height: 6px; border-radius: 999px; background: #eceef5; overflow: hidden; } .barra span { display: block; height: 100%; border-radius: 999px; background: var(--brand); }
    .vence { margin: 0; font-size: .85rem; color: #334155; }
    .acciones { display: flex; gap: 8px; flex-wrap: wrap; margin-top: auto; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 38px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--line);
      background: #fff; color: #0f172a; font: inherit; font-size: .85rem; font-weight: 600; cursor: pointer; transition: .15s; }
    .btn:hover:not(:disabled) { border-color: #c7cbe0; } .btn:disabled { opacity: .5; cursor: not-allowed; }
    .btn.primary { background: var(--brand); border-color: var(--brand); color: #fff; } .btn.primary:hover:not(:disabled) { background: #4338ca; }
    .btn.sel { background: var(--soft); border-color: var(--brand); color: var(--brand); } .btn.alt { border-color: #c7cbe0; }
    .btn.ghost { background: transparent; border-color: #334155; color: #cbd5e1; } .btn.lg { height: 46px; padding: 0 22px; } .btn.block { width: 100%; }
    .seg { display: inline-flex; padding: 4px; background: #eceef5; border-radius: 12px; }
    .seg button { border: 0; background: none; padding: 7px 16px; border-radius: 9px; font: inherit; font-weight: 600; color: var(--muted); cursor: pointer; }
    .seg button.on { background: #fff; color: #0f172a; box-shadow: 0 1px 3px rgb(15 23 42 / .12); }
    .opcion { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 12px; padding: 10px 14px; background: #fafbfe; border: 1px solid var(--line);
      border-radius: 12px; font: inherit; color: inherit; cursor: pointer; text-align: left; transition: .15s; }
    .opcion:hover { border-color: #c7cbe0; } .opcion.sel { background: var(--soft); border-color: var(--brand); color: var(--brand); }
    .o-t { font-size: .88rem; font-weight: 600; } .o-p { font-weight: 700; white-space: nowrap; } .o-p small { color: var(--muted); font-weight: 500; }
    .srv { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .srv li { display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: #fff; border: 1px solid var(--line); border-radius: 14px; }
    .srv-t { flex: 1; min-width: 0; display: flex; flex-direction: column; } .srv-t small { color: var(--muted); }
    .extras { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 16px; background: #fff; border: 1px solid var(--line); border-radius: 16px; flex-wrap: wrap; }
    .e-info { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 240px; } .e-info small { display: block; margin-top: 2px; color: var(--muted); line-height: 1.4; }
    .step { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: #fff; }
    .step button { display: grid; place-items: center; width: 40px; height: 40px; border: 0; background: #fafbfe; color: #0f172a; cursor: pointer; }
    .step button:disabled { opacity: .4; cursor: not-allowed; } .step input { width: 64px; height: 40px; border: 0; text-align: center; font: inherit; font-weight: 700; outline: 0; }
    .dos { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; } .lista { display: flex; flex-direction: column; gap: 10px; }
    .fila { padding: 12px 14px; background: #fff; border: 1px solid var(--line); border-radius: 12px; }
    .f-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; } .fila small { color: var(--muted); }
    .fila ul { margin: 6px 0 0; padding-left: 18px; font-size: .84rem; color: #334155; } .warn-t { color: #b45309; }
    .pedido { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 40; display: flex; align-items: center; gap: 12px; width: min(720px, calc(100% - 24px));
      padding: 10px 12px 10px 20px; background: #0f172a; color: #fff; border-radius: 16px; box-shadow: 0 24px 48px -16px rgb(15 23 42 / .55); }
    .p-info { flex: 1; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; } .sep { width: 1px; height: 16px; background: #334155; }
    .overlay { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 16px; background: rgb(15 23 42 / .5); overflow-y: auto; }
    .modal { width: min(480px, 100%); display: flex; flex-direction: column; gap: 14px; padding: 22px; background: #fff; border-radius: 18px; box-shadow: 0 30px 70px -20px rgb(0 0 0 / .5); }
    .m-cab { display: flex; justify-content: space-between; align-items: center; } .m-cab h3 { margin: 0; font-size: 1.1rem; }
    .x { display: grid; place-items: center; width: 34px; height: 34px; border: 0; border-radius: 10px; background: none; color: var(--muted); cursor: pointer; } .x:hover { background: #f1f2f8; color: #0f172a; }
    .m-lineas { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .m-lineas li { display: flex; justify-content: space-between; gap: 12px; font-size: .9rem; }
    .m-total { display: flex; justify-content: space-between; padding-top: 12px; border-top: 1px solid var(--line); font-size: 1.1rem; }
    .m-botones { display: flex; gap: 10px; flex-wrap: wrap; }
    .demo { display: flex; align-items: center; gap: 8px; margin: 0; padding: 10px 14px; border-radius: 10px; background: #fef3c7; color: #92400e; font-size: .86rem; }
    .seguro { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--muted); font-size: .8rem; }
    @media (max-width: 760px) { .dos { grid-template-columns: 1fr; } .cab { flex-direction: column; align-items: flex-start; } .pedido { flex-wrap: wrap; } }
  `],
})
export class CuentaPage implements OnInit {
  private readonly api: CuentaService = inject(CuentaService);
  private readonly publico: PublicoService = inject(PublicoService);
  private readonly auth: AuthService = inject(AuthService);
  readonly carrito: CarritoService = inject(CarritoService);
  private readonly rt: TiempoRealService = inject(TiempoRealService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);

  readonly datos = signal<MiCuenta | null>(null);
  readonly cat = signal<CatalogoPub | null>(null);
  readonly orden = signal<OrdenCreada | null>(null);
  readonly procesando = signal<boolean>(false);
  readonly error = signal<string>('');
  readonly aviso = signal<string>('');
  readonly modalError = signal<string>('');

  readonly esEmpresa = computed<boolean>(() => this.datos()?.empresa.tipo === 'empresa');
  readonly suscripciones = computed<SuscripcionCuenta[]>(() => this.datos()?.suscripciones ?? []);
  readonly activas = computed<SuscripcionCuenta[]>(() => this.suscripciones().filter((s) => s.vigente));

  readonly proximaTxt = computed<string>(() => {
    const v = this.activas().map((s) => s.vence_en).sort()[0];
    return v ? `${this.fecha(v)} · ${this.diasTxt(v)}` : 'Sin suscripciones activas';
  });

  /** Planes de mis suscripciones vigentes (sirven para saber el precio de usuarios adicionales). */
  readonly planesActivos = computed<PlanPub[]>(() => {
    const c = this.cat();
    if (!c) return [];
    const ids = new Set(this.activas().map((s) => s.plan_id));
    return c.planes.filter((p) => ids.has(p.id));
  });

  /** Planes a la venta que aún no tengo y que tienen precio para mi tipo de cuenta y periodo. */
  readonly disponibles = computed<PlanPub[]>(() => {
    const c = this.cat();
    if (!c) return [];
    const mios = new Set(this.suscripciones().map((s) => s.plan_id));
    return c.planes.filter((p) => !mios.has(p.id) && this.modos(p).length > 0);
  });

  readonly serviciosVenta = computed<ServicioPub[]>(() => (this.cat()?.servicios ?? []).filter((s) => s.precio !== null));

  readonly resumen = computed(() => {
    const c = this.cat();
    return c ? this.carrito.resumen(c, this.planesActivos()) : { lineas: [], total: 0, ok: false };
  });

  readonly extrasTxt = computed<string>(() => {
    const e = this.datos()?.empresa;
    const unit = this.precioExtraUnit();
    const per = this.carrito.periodo() === 'anual' ? 'año' : 'mes';
    if (unit === 0) return 'Tus planes actuales no ofrecen usuarios adicionales en este periodo.';
    const base = `${this.soles(unit)} por usuario y por ${per}. `;
    if (e?.extras_vigentes && e.extras_vence_en) {
      return `${base}Tienes ${e.usuarios_extra} adicionales vigentes hasta el ${this.fecha(e.extras_vence_en)}. Elige el total que necesitas.`;
    }
    return `${base}Elige cuántos usuarios necesitas además de los incluidos en tu plan.`;
  });

  ngOnInit(): void {
    this.carrito.vaciar();
    this.cargar();
    this.cargarCatalogo();
    // Tiempo real: cambios de precios, planes o de tu suscripción se ven sin recargar
    this.rt.cambios('catalogo', 'acceso').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.cargar();
      this.cargarCatalogo();
    });
  }

  private cargarCatalogo(): void {
    this.publico.catalogo().subscribe({
      next: (c) => this.cat.set(c),
      error: () => this.error.set('No pudimos cargar los planes disponibles.'),
    });
  }

  private cargar(): void {
    this.api.cuenta().subscribe({
      next: (d) => {
        this.carrito.tipo.set(d.empresa.tipo);
        this.datos.set(d);
      },
      error: (e: HttpErrorResponse) => this.error.set(this.msg(e)),
    });
  }

  // ---------- Formato ----------
  soles(n: number): string {
    return 'S/ ' + n.toLocaleString('es-PE', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  fecha(iso: string): string {
    return new Date(iso).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  fechaHora(iso: string): string {
    return new Date(iso).toLocaleString('es-PE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  nombreModulo(m: string): string { return NOMBRE_MODULO[m] ?? m; }
  estadoPedido(e: string): string { return ESTADO_PEDIDO[e] ?? e; }
  diasRestantes(iso: string): number { return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)); }
  diasTxt(iso: string): string {
    const d = this.diasRestantes(iso);
    return d === 0 ? 'vence hoy' : `quedan ${d} ${d === 1 ? 'día' : 'días'}`;
  }

  // ---------- Estado de cada suscripción ----------
  tono(s: SuscripcionCuenta): 'ok' | 'warn' | 'bad' {
    if (!s.vigente) return 'bad';
    return this.diasRestantes(s.vence_en) <= (s.periodo === 'anual' ? 30 : 7) ? 'warn' : 'ok';
  }
  textoEstado(s: SuscripcionCuenta): string {
    const t = this.tono(s);
    if (t === 'bad') return s.estado === 'cancelada' ? 'Cancelada' : 'Vencida';
    return t === 'warn' ? 'Por vencer' : 'Vigente';
  }
  progreso(s: SuscripcionCuenta): number {
    if (!s.vigente) return 0;
    return Math.min(100, Math.round((this.diasRestantes(s.vence_en) / (s.periodo === 'anual' ? 365 : 30)) * 100));
  }

  // ---------- Precios ----------
  private precio(p: PlanPub, concepto: string): number | null {
    const x = p.precios.find((y) => y.tipo_cuenta === this.carrito.tipo() && y.concepto === concepto && y.periodo === this.carrito.periodo());
    return x ? x.monto : null;
  }

  modos(p: PlanPub): Modo[] {
    const out: Modo[] = [];
    const defs: [ModoPlan, string][] = [['ver', 'Solo visualizar'], ['cotizar', 'Visualizar y cotizar']];
    for (const [modo, label] of defs) {
      const m = this.precio(p, modo);
      if (m !== null) out.push({ modo, label, monto: m });
    }
    return out;
  }

  private planDe(s: SuscripcionCuenta): PlanPub | undefined { return this.cat()?.planes.find((p) => p.id === s.plan_id); }

  precioSub(s: SuscripcionCuenta, modo: ModoPlan): number {
    const p = this.planDe(s);
    return p ? (this.precio(p, modo) ?? 0) : 0;
  }

  puedeRenovar(s: SuscripcionCuenta): boolean {
    const p = this.planDe(s);
    return !!p && this.precio(p, s.modo) !== null;
  }

  puedeMejorar(s: SuscripcionCuenta): boolean {
    const p = this.planDe(s);
    return !!p && s.modo === 'ver' && this.precio(p, 'cotizar') !== null;
  }

  precioExtraUnit(): number {
    const c = this.cat();
    if (!c) return 0;
    const ids = new Set<number>([...this.planesActivos().map((p) => p.id), ...this.carrito.planes().map((i) => i.plan_id)]);
    return Math.max(0, ...c.planes.filter((p) => ids.has(p.id)).map((p) => this.precio(p, 'usuario_extra') ?? 0));
  }

  // ---------- Acciones sobre el pedido ----------
  enRenovar(s: SuscripcionCuenta): boolean { return this.carrito.enCarrito(s.plan_id, s.modo); }
  enMejora(s: SuscripcionCuenta): boolean { return this.carrito.enCarrito(s.plan_id, 'cotizar'); }
  renovar(s: SuscripcionCuenta): void { this.carrito.alternarPlan(s.plan_id, s.modo); }
  mejorar(s: SuscripcionCuenta): void { this.carrito.alternarPlan(s.plan_id, 'cotizar'); }

  cambiarExtras(delta: number): void { this.carrito.extras.set(Math.max(0, Math.min(200, this.carrito.extras() + delta))); }
  setExtras(v: string): void {
    const n = Math.floor(Number(v));
    this.carrito.extras.set(Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 0);
  }

  // ---------- Pago ----------
  revisar(): void {
    if (this.procesando() || !this.resumen().ok) return;
    this.procesando.set(true);
    this.error.set('');
    this.aviso.set('');
    this.api.crearOrden({
      periodo: this.carrito.periodo(), planes: this.carrito.planes(), servicios: this.carrito.servicios(),
      usuarios_extra: this.esEmpresa() ? this.carrito.extras() : 0,
    }).subscribe({
      next: (o) => { this.procesando.set(false); this.modalError.set(''); this.orden.set(o); },
      error: (e: HttpErrorResponse) => { this.procesando.set(false); this.error.set(this.msg(e)); },
    });
  }

  cancelarPago(): void { this.orden.set(null); this.modalError.set(''); }

  pagarDemo(rechazar: boolean): void { this.pagar(rechazar ? { simular: 'rechazado' } : {}); }

  async pagarCulqi(): Promise<void> {
    const o = this.orden();
    if (!o || this.procesando()) return;
    this.modalError.set('');
    try {
      const r = await pagarConCulqi(
        { total: o.total, moneda: o.moneda, llave: o.pago.llave_publica ?? '' },
        (d) => firstValueFrom(this.api.pagar(o.orden_id, d)),
        (v) => this.procesando.set(v),
      );
      this.orden.set(null);
      this.carrito.vaciar();
      this.aviso.set(r.mensaje);
      this.cargar();
      this.auth.refrescar().subscribe({ error: () => undefined }); // el menú se actualiza con los permisos nuevos
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      this.modalError.set(e instanceof HttpErrorResponse ? this.msg(e) : (e instanceof Error ? e.message : 'No se pudo procesar la tarjeta'));
    }
  }
  private pagar(datos: { token?: string; simular?: string }): void {
    const o = this.orden();
    if (!o || this.procesando()) return;
    this.procesando.set(true);
    this.modalError.set('');
    this.api.pagar(o.orden_id, datos).subscribe({
      next: (r) => {
        this.procesando.set(false);
        this.orden.set(null);
        this.carrito.vaciar();
        this.aviso.set(r.mensaje);
        this.cargar();
        this.auth.refrescar().subscribe({ error: () => undefined }); // el menú se actualiza con los permisos nuevos
        window.scrollTo({ top: 0, behavior: 'smooth' });
      },
      error: (e: HttpErrorResponse) => { this.procesando.set(false); this.modalError.set(this.msg(e)); },
    });
  }

  private msg(e: HttpErrorResponse): string {
    const d = e.error?.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return 'Revisa los datos del pedido.';
    return 'No se pudo conectar con el servidor';
  }
}