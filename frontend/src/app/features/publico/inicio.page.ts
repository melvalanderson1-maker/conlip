import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy, Component, DestroyRef, Directive, ElementRef, OnDestroy, OnInit,
  afterNextRender, computed, inject, input, signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { PublicoRealtimeService } from '../../core/publico-realtime.service';
import { CarritoService, ModoPlan } from '../../core/carrito.service';
import { BeneficioPub, CatalogoPub, PlanPub, PublicoService, ServicioPub } from './publico.service';
import { CursosPublicosComponent } from './cursos-publicos.component';
import { AnunciosBarraComponent } from '../anuncios/anuncios-barra.component';

interface Linea { concepto: string; label: string; monto: number; nota: string; }
interface Paquete { id: string; nombre: string; desc: string; icono: string; planes: PlanPub[]; servicios: ServicioPub[]; }

const NOMBRE_MODULO: Record<string, string> = {
  perucompras: 'Perú Compras', mayor: 'Contratos Mayores', menor: 'Contratos Menores',
};
const BASE = [
  { id: 'menor', nombre: 'Contratos Menores', desc: 'Búsqueda y cotización de contrataciones menores', icono: 'doc' },
  { id: 'mayor', nombre: 'Contratos Mayores', desc: 'Búsqueda y cotización de contrataciones en SEACE', icono: 'civic' },
  { id: 'perucompras', nombre: 'Perú Compras', desc: 'Inteligencia comercial, catálogos electrónicos y capacitación', icono: 'cart' },
];

/** Iconos de trazo (24x24). Todo el set vive aquí, sin dependencias externas ni emojis. */
const ICONOS: Record<string, string> = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4-4',
  users: 'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6.5 8c0-3 2.9-5 6.5-5s6.5 2 6.5 5M16 5a3.2 3.2 0 0 1 0 6.2M18.5 14.8c1.8.7 3 2.2 3 4.2',
  bolt: 'M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z',
  shield: 'M12 3.5 5 6v5.5c0 4.2 2.8 7.4 7 9 4.2-1.6 7-4.8 7-9V6l-7-2.5ZM9 12l2 2 4-4',
  doc: 'M7 3.5h7l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Zm7 0V8h4M9 12.5h6M9 16h6',
  civic: 'M3.5 9 12 4l8.5 5M5.5 9.5V17M10 9.5V17M14 9.5V17M18.5 9.5V17M3.5 20h17M4.5 17h15',
  cart: 'M3 4h2.5l2 10.5h10L19.5 8H6.5M9.5 19.5h.01M16.5 19.5h.01',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  up: 'M12 19V5M5.5 11.5 12 5l6.5 6.5',
  right: 'M5 12h14M13 6l6 6-6 6',
  chat: 'M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-7l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5Z',
  star: 'M12 4l2.4 5 5.4.7-4 3.8 1 5.4L12 16.3 7.2 18.9l1-5.4-4-3.8 5.4-.7L12 4Z',
  chevron: 'm6 9 6 6 6-6',
  lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z',
  bell: 'M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9ZM10 20a2 2 0 0 0 4 0',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4.5V12l3 2',
  layers: 'M12 3 3 7.5 12 12l9-4.5L12 3Zm-9 9 9 4.5 9-4.5M3 16.5 12 21l9-4.5',
};

/** Icono SVG reutilizable (sin emojis). */
import { WhatsappFlotanteComponent } from './whatsapp-flotante.component';

@Component({
  selector: 'app-ico',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[style.width.px]': 'size()', '[style.height.px]': 'size()' },
  template: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path [attr.d]="d()" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>`,
  styles: [`:host { display: inline-flex; flex: none; } svg { width: 100%; height: 100%; }`],
})
export class IcoComponent {
  readonly n = input.required<string>();
  readonly size = input<number>(20);
  readonly d = computed<string>(() => ICONOS[this.n()] ?? '');
}

/** Aparece con fade + slide cuando entra al viewport (solo visual). */
@Directive({ selector: '[reveal]', host: { class: 'rv' } })
export class RevealDirective {
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      if (typeof IntersectionObserver === 'undefined') { el.classList.add('in'); return; }
      const io = new IntersectionObserver(([e]) => {
        if (e.isIntersecting) { el.classList.add('in'); io.disconnect(); }
      }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
      io.observe(el);
      destroyRef.onDestroy(() => io.disconnect());
    });
  }
}

@Component({
  selector: 'app-inicio',
  imports: [WhatsappFlotanteComponent,RouterLink, NgTemplateOutlet, RevealDirective, IcoComponent, CursosPublicosComponent, AnunciosBarraComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:scroll)': 'onScroll()' },
  template: `
    <div class="progress" aria-hidden="true"></div>
    <app-anuncios-barra />

    <!-- ───────── Barra superior ───────── -->
    <header class="nav" [class.sc]="scrolled()">
      <div class="nav-in">
        <div class="marca"><span class="logo">{{ inicial() }}</span><b>{{ nombre() }}</b></div>
        <nav class="links" aria-label="Principal">
          <button type="button" (click)="ir('plataforma')">Plataforma</button>
          @if (hayPlanes()) { <button type="button" (click)="ir('planes')">Paquetes</button> }
          <button type="button" (click)="ir('cursos')">Cursos</button>
          <button type="button" (click)="ir('proceso')">Cómo funciona</button>
          <button type="button" (click)="ir('faq')">Preguntas</button>
        </nav>
        <div class="acciones">
          <a class="btn ghost sm" routerLink="/login">Ingresar</a>
          @if (hayPlanes()) { <button type="button" class="btn primary sm" (click)="ir('planes')">Ver paquetes</button> }
        </div>
      </div>
    </header>

    <!-- ───────── Hero ───────── -->
    <section class="hero">
      <div class="hero-in">
        <div class="hero-txt">
          <span class="pill"><i></i>Contrataciones del Estado</span>
          <h1>{{ cfg('sitio_titular') }}</h1>
          <p>{{ cfg('sitio_subtitulo') }}</p>
          <div class="cta">
            @if (hayPlanes()) {
              <button type="button" class="btn light lg" (click)="ir('planes')">
                Ver paquetes <app-ico n="right" [size]="18" />
              </button>
            }
            <a class="btn ghost lg" routerLink="/login">Ya tengo cuenta</a>
          </div>
          <ul class="confianza">
            @for (c of confianza; track c.t) {
              <li><app-ico [n]="c.i" [size]="16" /> {{ c.t }}</li>
            }
          </ul>
        </div>

        <!-- Vista ilustrativa del panel -->
        <div class="mock" aria-hidden="true">
          <div class="mk-card">
            <div class="mk-bar"><i></i><i></i><i></i><span>Panel de contrataciones</span></div>
            <div class="mk-body">
              <div class="mk-tabs"><span class="on">Vigentes</span><span>En evaluación</span><span>Asignadas</span></div>
              <div class="mk-row">
                <span class="mk-ico"><app-ico n="doc" [size]="18" /></span>
                <div class="mk-txt"><b>Servicio de mantenimiento de equipos</b><small>Contratos Menores · vence en 5 días</small></div>
                <span class="chip ok">Vigente</span>
                <span class="mk-av">AL</span>
              </div>
              <div class="mk-row">
                <span class="mk-ico"><app-ico n="cart" [size]="18" /></span>
                <div class="mk-txt"><b>Suministro de insumos de limpieza</b><small>Perú Compras · catálogo electrónico</small></div>
                <span class="chip info">Asignada</span>
                <span class="mk-av b">MR</span>
              </div>
              <div class="mk-row">
                <span class="mk-ico"><app-ico n="civic" [size]="18" /></span>
                <div class="mk-txt"><b>Adquisición de materiales de oficina</b><small>Contratos Mayores · vence en 2 días</small></div>
                <span class="chip warn">Por vencer</span>
                <span class="mk-av c">JP</span>
              </div>
            </div>
          </div>
          <div class="mk-toast">
            <span class="t-ico"><app-ico n="bell" [size]="18" /></span>
            <div><b>Nueva asignación</b><small>Tu compañero te asignó una contratación</small></div>
          </div>
          <span class="mk-cap">Vista ilustrativa</span>
        </div>
      </div>
    </section>

    <div class="fuentes" aria-label="Fuentes de información">
      <div class="fuentes-in">
        <span class="f-lab">Información de</span>
        <ul>
          <li>SEACE</li><li>PLADICOP</li><li>Perú Compras</li>
        </ul>
      </div>
    </div>

    <!-- ───────── Plataforma ───────── -->
    <section id="plataforma" class="seccion">
      <div reveal class="sec-head">
        <span class="eyebrow">Plataforma</span>
        <h2>Todo el ciclo de cotización, en un solo lugar</h2>
        <p class="sub">Desde encontrar la oportunidad hasta coordinar a tu equipo para cotizarla.</p>
      </div>
      <div class="feats">
        @for (v of ventajas; track v.t) {
          <article reveal class="feat">
            <span class="f-ico"><app-ico [n]="v.i" [size]="22" /></span>
            <h3>{{ v.t }}</h3>
            <p>{{ v.d }}</p>
          </article>
        }
      </div>
    </section>

    @if (error()) { <p class="aviso">{{ error() }}</p> }

    <!-- ───────── Paquetes ───────── -->
    @if (hayPlanes()) {
      <section id="planes" class="seccion">
        <div reveal class="sec-head centro">
          <span class="eyebrow">Paquetes</span>
          <h2>Elige tu paquete</h2>
          <p class="sub">Tres formas de venderle al Estado. Elige una o combínalas en un plan.</p>
        </div>

        @if (paquetes().length) {
          <div class="paquetes">
            @for (p of paquetes(); track p.id) {
              <button type="button" reveal class="paq" [class.on]="actual()?.id === p.id"
                      [attr.aria-pressed]="actual()?.id === p.id" (click)="sel.set(p.id)">
                <span class="tick"><app-ico n="check" [size]="14" /></span>
                <span class="paq-ico"><app-ico [n]="p.icono" [size]="24" /></span>
                <b>{{ p.nombre }}</b>
                <small>{{ p.desc }}</small>
              </button>
            }
          </div>
        }

        <div class="toggles">
          <div class="seg" [attr.data-i]="tipo() === 'empresa' ? 1 : 0">
            <span class="thumb"></span>
            <button type="button" [class.on]="tipo() === 'persona'" (click)="tipo.set('persona')">Persona natural</button>
            <button type="button" [class.on]="tipo() === 'empresa'" (click)="tipo.set('empresa')">Empresa</button>
          </div>
          <div class="seg" [attr.data-i]="periodo() === 'anual' ? 1 : 0">
            <span class="thumb"></span>
            <button type="button" [class.on]="periodo() === 'mensual'" (click)="periodo.set('mensual')">Mensual</button>
            <button type="button" [class.on]="periodo() === 'anual'" (click)="periodo.set('anual')">Anual</button>
          </div>
        </div>

        @if (actual(); as a) {
          @for (x of [a]; track x.id) {
            <div class="panel">
              <h3 class="tit">{{ x.nombre }}</h3>
              @if (x.planes.length) {
                <h4 class="subtit">Suscripciones</h4>
                <div class="planes">
                  @for (p of x.planes; track p.id) {
                    <ng-container [ngTemplateOutlet]="tarjeta" [ngTemplateOutletContext]="{ $implicit: p }" />
                  }
                </div>
              }
              <div id="cursos"><app-cursos-publicos [filtro]="x.id" titulo="Cursos incluidos" /></div>
              @if (x.servicios.length) {
                <h4 class="subtit">Servicios personalizados</h4>
                @for (g of grupos(x.servicios); track g.categoria) {
                  <h5 class="cat">{{ g.categoria }}</h5>
                  <div class="servs">
                    @for (s of g.items; track s.id) {
                      <ng-container [ngTemplateOutlet]="tarjetaServ" [ngTemplateOutletContext]="{ $implicit: s }" />
                    }
                  </div>
                }
              }
            </div>
          }
        }

        @if (combos().length) {
          <div reveal class="sec-head centro combo-t">
            <span class="eyebrow">Combos</span>
            <h3 class="h3">Combos con varios módulos</h3>
            <p class="sub">Todo lo que necesitas en un solo plan.</p>
          </div>
          <div class="planes">
            @for (p of combos(); track p.id) {
              <ng-container [ngTemplateOutlet]="tarjeta" [ngTemplateOutletContext]="{ $implicit: p }" />
            }
          </div>
        }

        @if (planes().length > 1 && beneficios().length) {
          <div reveal class="sec-head centro comp-t">
            <span class="eyebrow">Comparativa</span>
            <h3 class="h3">Compara los planes</h3>
          </div>
          <div reveal class="tabla-wrap">
            <table class="comp">
              <thead>
                <tr>
                  <th>Beneficios</th>
                  @for (p of planes(); track p.id) { <th>{{ p.nombre }}</th> }
                </tr>
              </thead>
              <tbody>
                @for (b of beneficios(); track b.id) {
                  <tr>
                    <td>{{ b.nombre }}</td>
                    @for (p of planes(); track p.id) {
                      <td>
                        @if (!valor(p, b)) {
                          <span class="no">—</span>
                        } @else if (b.tipo === 'check') {
                          <span class="ok"><app-ico n="check" [size]="14" /></span>
                        } @else {
                          {{ valor(p, b) }}
                        }
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    }

    <!-- ───────── Servicios sin paquete ───────── -->
    @if (generales().length) {
      <section id="generales" class="seccion alt">
        <div reveal class="sec-head">
          <span class="eyebrow">Servicios</span>
          <h2>Servicios personalizados</h2>
          <p class="sub">Te acompañamos de la mano. Solicita el que necesites.</p>
        </div>
        @for (g of grupos(generales()); track g.categoria) {
          <h5 class="cat">{{ g.categoria }}</h5>
          <div class="servs">
            @for (s of g.items; track s.id) {
              <ng-container [ngTemplateOutlet]="tarjetaServ" [ngTemplateOutletContext]="{ $implicit: s }" />
            }
          </div>
        }
      </section>
    }

    <app-cursos-publicos filtro="general" modo="seccion" titulo="Capacitación para todos" />

    <!-- ───────── Cómo funciona ───────── -->
    <section id="proceso" class="seccion">
      <div reveal class="sec-head centro">
        <span class="eyebrow">Cómo funciona</span>
        <h2>Empieza en tres pasos</h2>
      </div>
      <div class="pasos">
        @for (p of pasos; track p.t; let i = $index) {
          <article reveal class="paso">
            <span class="p-num">{{ i + 1 }}</span>
            <h3>{{ p.t }}</h3>
            <p>{{ p.d }}</p>
          </article>
        }
      </div>
    </section>

    <!-- ───────── Preguntas frecuentes ───────── -->
    <section id="faq" class="seccion estrecha">
      <div reveal class="sec-head centro">
        <span class="eyebrow">Preguntas frecuentes</span>
        <h2>Resolvemos tus dudas</h2>
      </div>
      <div reveal class="faq">
        @for (f of faq; track f.q) {
          <details>
            <summary><span>{{ f.q }}</span><app-ico n="chevron" [size]="18" /></summary>
            <p>{{ f.a }}</p>
          </details>
        }
      </div>
    </section>

    <!-- ───────── Banda final ───────── -->
    <section class="banda">
      <div reveal class="banda-in">
        <div>
          <h2>Empieza a cotizar con tu equipo</h2>
          <p>Elige tu paquete y recibe tu acceso por correo en minutos.</p>
        </div>
        <div class="banda-cta">
          @if (hayPlanes()) {
            <button type="button" class="btn light lg" (click)="ir('planes')">Ver paquetes <app-ico n="right" [size]="18" /></button>
          }
          @if (ctaGeneral(); as url) {
            <a class="btn ghost lg" [href]="url" target="_blank" rel="noopener">Hablar con ventas</a>
          }
        </div>
      </div>
    </section>

    @if (carrito.cantidad() > 0) {
      <div class="barra" role="region" aria-label="Tu pedido">
        <span class="b-info">
          <app-ico n="cart" [size]="18" />
          <b>{{ carrito.cantidad() }}</b> {{ carrito.cantidad() === 1 ? 'elemento' : 'elementos' }}
          <i></i>
          <b>{{ soles(totalEstimado()) }}</b>
        </span>
        <button type="button" class="btn ghost sm" (click)="carrito.vaciar()">Vaciar</button>
        <a class="btn primary sm" routerLink="/comprar">Continuar <app-ico n="right" [size]="16" /></a>
      </div>
    }

    <footer class="pie">
      <div class="pie-in">
        <div class="pie-marca"><span class="logo sm">{{ inicial() }}</span><b>{{ nombre() }}</b></div>
        <nav style="display:flex;gap:18px;font-size:.85rem">
          <a href="/terminos">Términos y condiciones</a>
          <a href="/privacidad">Privacidad</a>
        </nav>
        <span class="pie-contacto">
          @if (cfg('contacto_correo')) { {{ cfg('contacto_correo') }} }
          @if (cfg('contacto_whatsapp')) { · WhatsApp +{{ cfg('contacto_whatsapp') }} }
        </span>
      </div>
    </footer>
    <app-whatsapp-flotante />

    <!-- Botones flotantes -->
    <div class="fabs">
      <button type="button" class="fab up" [class.show]="fab()" (click)="arriba()" aria-label="Volver arriba">
        <app-ico n="up" [size]="20" />
      </button>
      @if (ctaGeneral(); as url) {
        <a class="fab wa" [href]="url" target="_blank" rel="noopener">
          <app-ico n="chat" [size]="20" /><span>Escríbenos</span>
        </a>
      }
    </div>

    <!-- Tarjeta de plan (se reutiliza en paquetes y combos) -->
    <ng-template #tarjeta let-p>
      <article reveal class="plan" [class.dest]="p.destacado">
        @if (p.destacado) { <span class="rec"><app-ico n="star" [size]="13" /> Recomendado</span> }
        <h3>{{ p.nombre }}</h3>
        <p class="st">{{ p.subtitulo }}</p>

        <div class="precio">
          @for (l of lineasPrecio(p); track l.concepto + tipo() + periodo(); let i = $index) {
            <div class="linea" [style.--i]="i">
              <span class="lab">{{ l.label }}</span>
              <span><b>{{ soles(l.monto) }}</b> <small>/ {{ periodo() === 'anual' ? 'año' : 'mes' }}</small></span>
              @if (l.nota) { <small class="nota">{{ l.nota }}</small> }
            </div>
          } @empty {
            <div class="linea"><span class="lab">Consulta el precio con nuestro equipo</span></div>
          }
        </div>

        @if (tipo() === 'empresa') {
          <ul class="extras">
            @for (n of notasEmpresa(p); track n) { <li>{{ n }}</li> }
          </ul>
        }

        <div class="mods">
          @for (m of modulosDe(p); track m) { <span class="mod">{{ m }}</span> }
        </div>

        <ul class="incluye">
          @for (t of incluye(p); track t) { <li>{{ t }}</li> }
        </ul>

        @for (m of modosPlan(p); track m.modo) {
          <button type="button" class="btn block" [class.primary]="enCarrito(p, m.modo)" [class.out]="!enCarrito(p, m.modo)"
                  (click)="alternarPlan(p, m.modo)">
            @if (enCarrito(p, m.modo)) {
              <app-ico n="check" [size]="16" /> {{ m.label }} · Quitar
            } @else {
              Elegir: {{ m.label }}
            }
          </button>
        }
        @if (!modosPlan(p).length) {
          @if (ctaPlan(p); as url) {
            <a class="btn out block" [href]="url" target="_blank" rel="noopener">Consultar</a>
          }
        }
      </article>
    </ng-template>

    <!-- Tarjeta de servicio -->
    <ng-template #tarjetaServ let-s>
      <article reveal class="serv">
        <h4>{{ s.nombre }}</h4>
        @if (s.descripcion) { <p class="desc">{{ s.descripcion }}</p> }
        <ul>
          @for (e of s.entregables; track $index) { <li>{{ e }}</li> }
        </ul>
        <div class="serv-pie">
          <span class="pr">{{ s.precio === null ? 'A cotizar' : 'Desde ' + soles(s.precio) }}</span>
          @if (s.precio !== null) {
            <button type="button" class="btn sm" [class.primary]="carrito.servicios().includes(s.id)"
                    [class.out]="!carrito.servicios().includes(s.id)" (click)="carrito.alternarServicio(s.id)">
              @if (carrito.servicios().includes(s.id)) { <app-ico n="check" [size]="15" /> Agregado } @else { Agregar }
            </button>
          } @else {
            <a class="btn primary sm" routerLink="/solicitar" [queryParams]="{ servicio: s.id }">Solicitar cotización</a>
          }
        </div>
      </article>
    </ng-template>
  `,
  styles: [`
    :host {
      --navy: #0a1a3a; --navy-2: #112a5e; --blue: #1d4ed8; --blue-2: #2f6bff; --sky: #8fb0ff;
      --red: #c8102e; --bg: #f5f7fb; --ink: #0f1c3a; --muted: #5a6784; --line: #dfe5f1;
      --ease: cubic-bezier(.2, .8, .2, 1);
      display: block; position: relative; overflow-x: clip; background: var(--bg); color: var(--ink);
      font-family: Sora, Inter, 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif; -webkit-font-smoothing: antialiased;
    }
    * { box-sizing: border-box; }

    /* ── Progreso de scroll ── */
    .progress { position: fixed; top: 0; left: 0; z-index: 70; width: 100%; height: 3px; transform: scaleX(0); transform-origin: 0 50%;
      background: linear-gradient(90deg, var(--red), var(--blue-2)); }
    @supports (animation-timeline: scroll()) {
      .progress { animation: grow linear both; animation-timeline: scroll(root); }
      @keyframes grow { to { transform: scaleX(1); } }
    }

    /* ── Aparición al hacer scroll ── */
    .rv { opacity: 0; translate: 0 20px;
      transition: opacity .7s var(--ease) var(--d, 0ms), translate .7s var(--ease) var(--d, 0ms), transform .3s var(--ease), box-shadow .3s, border-color .25s, background .25s, color .25s; }
    .rv.in { opacity: 1; translate: 0 0; }
    .rv:nth-child(2) { --d: 80ms; } .rv:nth-child(3) { --d: 160ms; } .rv:nth-child(4) { --d: 240ms; }

    /* ── Barra superior ── */
    .nav { position: sticky; top: 0; z-index: 60; background: rgb(10 26 58 / .92); backdrop-filter: blur(14px) saturate(1.3); border-bottom: 1px solid rgb(255 255 255 / .08); transition: box-shadow .3s; }
    .nav.sc { box-shadow: 0 14px 30px -18px rgb(10 26 58 / .9); }
    .nav-in { max-width: 1180px; height: 66px; margin: 0 auto; padding: 0 20px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .marca { display: flex; align-items: center; gap: 12px; color: #fff; font-size: 1.08rem; letter-spacing: -.01em; }
    .logo { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 11px; font-weight: 800; color: #fff; background: linear-gradient(135deg, var(--blue-2), var(--blue)); box-shadow: inset 0 -3px 0 var(--red), 0 8px 18px -8px rgb(29 78 216 / .8); }
    .logo.sm { width: 32px; height: 32px; border-radius: 9px; font-size: .9rem; }
    .links { display: flex; align-items: center; gap: 2px; }
    .links button { border: 0; background: none; font: inherit; font-size: .88rem; font-weight: 500; color: #c3d0f2; padding: 9px 14px; border-radius: 10px; cursor: pointer; transition: .2s; }
    .links button:hover { color: #fff; background: rgb(255 255 255 / .08); }
    .acciones { display: flex; align-items: center; gap: 8px; }

    /* ── Botones ── */
    .btn { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 44px; padding: 0 20px; border-radius: 12px;
      border: 1.5px solid var(--line); background: #fff; color: var(--ink); font: inherit; font-size: .9rem; font-weight: 600; text-decoration: none; cursor: pointer;
      transition: transform .2s, box-shadow .2s, border-color .2s, background .2s, color .2s; }
    .btn:hover { transform: translateY(-1px); }
    .btn:active { transform: scale(.98); }
    .btn:focus-visible, .seg button:focus-visible, .paq:focus-visible, .links button:focus-visible, .fab:focus-visible, summary:focus-visible { outline: 3px solid rgb(47 107 255 / .45); outline-offset: 2px; }
    .btn.primary { color: #fff; border-color: transparent; background: linear-gradient(135deg, var(--blue), var(--blue-2)); box-shadow: 0 10px 22px -10px rgb(29 78 216 / .8); }
    .btn.primary:hover { box-shadow: 0 14px 26px -10px rgb(29 78 216 / .9); }
    .btn.out { color: var(--blue); background: transparent; border-color: rgb(29 78 216 / .45); }
    .btn.out:hover { background: rgb(29 78 216 / .06); border-color: var(--blue); }
    .btn.light { color: var(--navy); border-color: transparent; background: #fff; box-shadow: 0 12px 26px -12px rgb(0 0 0 / .6); }
    .btn.ghost { color: #fff; background: rgb(255 255 255 / .05); border-color: rgb(255 255 255 / .28); }
    .btn.ghost:hover { background: rgb(255 255 255 / .12); border-color: rgb(255 255 255 / .6); }
    .btn.sm { height: 38px; padding: 0 16px; font-size: .84rem; }
    .btn.lg { height: 52px; padding: 0 26px; font-size: 1rem; }
    .btn.block { width: 100%; }

    /* ── Hero ── */
    .hero { position: relative; overflow: hidden; isolation: isolate; color: #fff;
      background: radial-gradient(80% 90% at 0% 0%, var(--navy-2) 0%, transparent 60%), radial-gradient(60% 70% at 100% 100%, #3a0f24 0%, transparent 65%), var(--navy); }
    .hero::before { content: ''; position: absolute; inset: 0; z-index: -1;
      background-image: linear-gradient(rgb(255 255 255 / .04) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / .04) 1px, transparent 1px); background-size: 48px 48px;
      -webkit-mask-image: radial-gradient(80% 90% at 35% 40%, #000 20%, transparent 80%); mask-image: radial-gradient(80% 90% at 35% 40%, #000 20%, transparent 80%); }
    .hero::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: linear-gradient(90deg, var(--red) 0 33.34%, #f5f7fb 33.34% 66.67%, var(--red) 66.67%); }
    .hero-in { max-width: 1180px; margin: 0 auto; padding: 76px 20px 92px; display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, .95fr); gap: 56px; align-items: center; }
    .hero-txt > * { animation: rise .8s var(--ease) both; }
    .hero-txt > :nth-child(2) { animation-delay: .08s; } .hero-txt > :nth-child(3) { animation-delay: .16s; } .hero-txt > :nth-child(4) { animation-delay: .24s; } .hero-txt > :nth-child(5) { animation-delay: .32s; }
    @keyframes rise { from { opacity: 0; transform: translateY(22px); } to { opacity: 1; transform: none; } }
    .pill { display: inline-flex; align-items: center; gap: 9px; padding: 7px 15px; border-radius: 999px; font-size: .76rem; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--sky); background: rgb(143 176 255 / .1); border: 1px solid rgb(143 176 255 / .3); }
    .pill i { width: 7px; height: 7px; border-radius: 50%; background: var(--sky); animation: ping 2.2s infinite; }
    @keyframes ping { 0% { box-shadow: 0 0 0 0 rgb(143 176 255 / .6); } 70% { box-shadow: 0 0 0 9px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
    h1 { margin: 22px 0 18px; font-size: clamp(2.1rem, 4.4vw, 3.5rem); line-height: 1.07; font-weight: 800; letter-spacing: -.035em; }
    .hero p { margin: 0 0 30px; max-width: 540px; color: #c3d0f2; font-size: 1.06rem; line-height: 1.7; }
    .cta { display: flex; gap: 12px; flex-wrap: wrap; }
    .confianza { display: flex; flex-wrap: wrap; gap: 10px 24px; margin: 34px 0 0; padding: 0; list-style: none; font-size: .84rem; color: #aebde6; }
    .confianza li { display: inline-flex; align-items: center; gap: 8px; } .confianza app-ico { color: var(--sky); }

    /* ── Vista ilustrativa ── */
    .mock { position: relative; width: 100%; max-width: 520px; margin-left: auto; animation: rise 1s var(--ease) .2s both; }
    .mk-card { overflow: hidden; background: #fff; color: var(--ink); border-radius: 18px; box-shadow: 0 40px 80px -30px rgb(0 0 0 / .7), 0 0 0 1px rgb(255 255 255 / .08); animation: float 8s ease-in-out infinite; }
    @keyframes float { 50% { transform: translateY(-8px); } }
    .mk-bar { display: flex; align-items: center; gap: 6px; padding: 12px 16px; background: #f1f4fa; border-bottom: 1px solid var(--line); font-size: .72rem; font-weight: 600; color: var(--muted); }
    .mk-bar i { width: 9px; height: 9px; border-radius: 50%; background: #d3dbec; } .mk-bar span { margin-left: 10px; }
    .mk-body { display: flex; flex-direction: column; gap: 10px; padding: 16px; }
    .mk-tabs { display: flex; gap: 6px; margin-bottom: 4px; }
    .mk-tabs span { padding: 5px 12px; border-radius: 999px; font-size: .7rem; font-weight: 600; color: var(--muted); background: #f1f4fa; }
    .mk-tabs .on { color: #fff; background: var(--navy); }
    .mk-row { display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; }
    .mk-ico { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; color: var(--blue); background: rgb(29 78 216 / .09); flex: none; }
    .mk-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .mk-txt b { font-size: .8rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .mk-txt small { color: var(--muted); font-size: .7rem; }
    .chip { padding: 3px 10px; border-radius: 999px; font-size: .66rem; font-weight: 700; white-space: nowrap; }
    .chip.ok { color: #047857; background: #d1fae5; } .chip.warn { color: #b45309; background: #fef3c7; } .chip.info { color: var(--blue); background: rgb(29 78 216 / .1); }
    .mk-av { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; font-size: .62rem; font-weight: 700; color: #fff; background: var(--blue); flex: none; }
    .mk-av.b { background: #0f766e; } .mk-av.c { background: var(--red); }
    .mk-toast { position: absolute; left: -30px; bottom: 6px; display: flex; align-items: center; gap: 12px; padding: 12px 18px 12px 14px; color: var(--ink); background: #fff; border-radius: 14px;
      border-left: 4px solid var(--blue); box-shadow: 0 24px 50px -20px rgb(0 0 0 / .7); animation: float 6s ease-in-out -2s infinite; }
    .mk-toast b { display: block; font-size: .8rem; } .mk-toast small { color: var(--muted); font-size: .7rem; }
    .t-ico { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; color: #fff; background: var(--blue); }
    .mk-cap { position: absolute; right: 0; bottom: -34px; font-size: .7rem; color: #8ea3d6; }

    /* ── Fuentes ── */
    .fuentes { background: #fff; border-bottom: 1px solid var(--line); }
    .fuentes-in { max-width: 1180px; margin: 0 auto; padding: 18px 20px; display: flex; align-items: center; gap: 22px; flex-wrap: wrap; }
    .f-lab { font-size: .72rem; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
    .fuentes ul { display: flex; flex-wrap: wrap; gap: 10px; margin: 0; padding: 0; list-style: none; }
    .fuentes li { padding: 6px 16px; border: 1px solid var(--line); border-radius: 999px; font-size: .8rem; font-weight: 700; letter-spacing: .04em; color: var(--navy); background: var(--bg); }

    /* ── Secciones ── */
    .seccion { position: relative; max-width: 1180px; margin: 0 auto; padding: 84px 20px 20px; }
    .seccion.estrecha { max-width: 860px; }
    .seccion.alt { max-width: none; margin-top: 64px; padding: 76px 20px 72px; background: #fff; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
    .seccion.alt > * { max-width: 1140px; margin-left: auto; margin-right: auto; }
    .sec-head { max-width: 680px; margin-bottom: 38px; } .sec-head.centro { margin-left: auto; margin-right: auto; text-align: center; }
    .eyebrow { display: inline-flex; align-items: center; gap: 10px; font-size: .72rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--blue); }
    .eyebrow::before { content: ''; width: 24px; height: 3px; border-radius: 2px; background: var(--red); }
    h2 { margin: 12px 0 10px; font-size: clamp(1.7rem, 3.2vw, 2.4rem); line-height: 1.12; font-weight: 800; letter-spacing: -.03em; }
    .h3 { margin: 12px 0 8px; font-size: 1.55rem; font-weight: 800; letter-spacing: -.025em; }
    .sub { margin: 0; color: var(--muted); line-height: 1.65; }
    .aviso { text-align: center; color: #a3122a; }

    /* ── Plataforma ── */
    .feats { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 18px; }
    .feat { padding: 28px; background: #fff; border: 1px solid var(--line); border-radius: 18px; }
    .feat:hover { transform: translateY(-4px); border-color: rgb(29 78 216 / .5); box-shadow: 0 24px 44px -28px rgb(10 26 58 / .5); }
    .f-ico { display: grid; place-items: center; width: 48px; height: 48px; margin-bottom: 22px; border-radius: 13px; color: var(--blue); background: rgb(29 78 216 / .09); transition: .3s; }
    .feat:hover .f-ico { color: #fff; background: var(--blue); }
    .feat h3 { margin: 0 0 8px; font-size: 1.08rem; font-weight: 700; letter-spacing: -.015em; }
    .feat p { margin: 0; color: var(--muted); font-size: .9rem; line-height: 1.65; }

    /* ── Paquetes ── */
    .paquetes { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 14px; }
    .paq { position: relative; overflow: hidden; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 26px; text-align: left; background: #fff; border: 1.5px solid var(--line); border-radius: 18px; font: inherit; color: inherit; cursor: pointer; }
    .paq::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 4px; background: var(--red); transform: scaleX(0); transform-origin: left; transition: transform .4s var(--ease); }
    .paq:hover { border-color: var(--blue); transform: translateY(-3px); }
    .paq-ico { display: grid; place-items: center; width: 48px; height: 48px; margin-bottom: 10px; border-radius: 13px; color: var(--blue); background: rgb(29 78 216 / .09); transition: .3s; }
    .paq b { font-size: 1.08rem; letter-spacing: -.01em; } .paq small { color: var(--muted); line-height: 1.55; font-size: .84rem; }
    .paq.on { color: #fff; border-color: var(--navy); background: linear-gradient(160deg, var(--navy), var(--navy-2)); box-shadow: 0 22px 44px -24px rgb(10 26 58 / .85); }
    .paq.on::before { transform: scaleX(1); } .paq.on small { color: #b4c0de; } .paq.on .paq-ico { color: #fff; background: rgb(255 255 255 / .1); }
    .tick { position: absolute; top: 16px; right: 16px; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; color: var(--navy); background: #fff; transform: scale(0); transition: transform .35s cubic-bezier(.34, 1.4, .64, 1); }
    .paq.on .tick { transform: scale(1); }

    /* ── Interruptores ── */
    .toggles { display: flex; justify-content: center; gap: 14px; flex-wrap: wrap; margin: 28px 0 6px; }
    .seg { position: relative; display: inline-grid; grid-template-columns: 1fr 1fr; padding: 4px; border-radius: 13px; background: #e3e9f6; }
    .seg .thumb { position: absolute; top: 4px; bottom: 4px; left: 4px; width: calc((100% - 8px) / 2); border-radius: 10px; background: var(--navy); box-shadow: inset 0 -2px 0 var(--red), 0 6px 14px -6px rgb(10 26 58 / .6); transition: transform .4s cubic-bezier(.34, 1.4, .64, 1); }
    .seg[data-i='1'] .thumb { transform: translateX(100%); }
    .seg button { position: relative; z-index: 1; border: 0; background: none; padding: 10px 22px; border-radius: 10px; font: inherit; font-size: .86rem; font-weight: 600; color: var(--muted); cursor: pointer; white-space: nowrap; transition: color .25s; }
    .seg button.on { color: #fff; }

    .panel { animation: swap .5s var(--ease) both; }
    @keyframes swap { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
    .tit { margin: 34px 0 2px; font-size: 1.55rem; font-weight: 800; letter-spacing: -.025em; }
    .subtit { margin: 22px 0 12px; font-size: .76rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
    .combo-t { margin-top: 72px; } .comp-t { margin-top: 72px; margin-bottom: 22px; }

    /* ── Planes ── */
    .planes { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; align-items: stretch; padding-top: 16px; }
    .plan { position: relative; display: flex; flex-direction: column; gap: 12px; padding: 28px; background: #fff; border: 1.5px solid var(--line); border-radius: 20px; }
    .plan:hover { transform: translateY(-4px); box-shadow: 0 26px 48px -28px rgb(10 26 58 / .5); }
    .plan:not(.dest):hover { border-color: rgb(29 78 216 / .5); }
    .plan h3 { margin: 0; font-size: 1.2rem; font-weight: 700; letter-spacing: -.02em; }
    .st { margin: 0; min-height: 2.5em; color: var(--muted); font-size: .86rem; line-height: 1.55; }
    .precio { display: flex; flex-direction: column; gap: 14px; padding: 16px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
    .linea { display: flex; flex-direction: column; animation: pop .5s cubic-bezier(.34, 1.4, .64, 1) both; animation-delay: calc(var(--i, 0) * 70ms); }
    @keyframes pop { from { opacity: 0; transform: translateY(10px) scale(.96); } to { opacity: 1; transform: none; } }
    .linea .lab { font-size: .78rem; color: var(--muted); }
    .linea b { font-size: 1.75rem; font-weight: 800; letter-spacing: -.035em; } .linea small { color: var(--muted); }
    .nota { display: inline-block; width: fit-content; margin-top: 5px; padding: 2px 10px; border-radius: 6px; font-weight: 600; color: var(--blue) !important; background: rgb(29 78 216 / .09); }
    .extras { margin: 0; padding-left: 18px; color: var(--muted); font-size: .8rem; line-height: 1.7; }
    .mods { display: flex; gap: 6px; flex-wrap: wrap; }
    .mod { padding: 4px 11px; border-radius: 7px; font-size: .7rem; font-weight: 600; color: var(--blue); background: rgb(29 78 216 / .09); }
    .incluye { margin: 0 0 10px; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; flex: 1; font-size: .86rem; }
    .incluye li { display: flex; gap: 10px; align-items: flex-start; line-height: 1.45; }
    .incluye li::before { content: ''; flex: none; width: 18px; height: 18px; margin-top: 1px; border-radius: 50%;
      background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5 12.5l4.5 4.5L19 7.5' fill='none' stroke='%231d4ed8' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 11px no-repeat, rgb(29 78 216 / .1); }

    .plan.dest { color: #fff; border-color: transparent; background: linear-gradient(170deg, var(--navy), var(--navy-2)); box-shadow: 0 30px 60px -30px rgb(10 26 58 / .85); }
    .plan.dest::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 4px; border-radius: 20px 20px 0 0; background: linear-gradient(90deg, var(--red), var(--blue-2)); }
    .rec { position: absolute; top: -13px; left: 24px; display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 8px; font-size: .7rem; font-weight: 700; letter-spacing: .04em; color: #fff; background: var(--red); box-shadow: 0 8px 18px -8px rgb(200 16 46 / .9); }
    .plan.dest .st, .plan.dest .linea .lab, .plan.dest .linea small { color: #9db2e6; }
    .plan.dest .precio { border-color: rgb(255 255 255 / .14); }
    .plan.dest .nota { color: #fff !important; background: rgb(255 255 255 / .12); }
    .plan.dest .extras { color: #b4c0de; }
    .plan.dest .mod { color: #dbe5fb; background: rgb(255 255 255 / .1); }
    .plan.dest .incluye { color: #dbe5fb; }
    .plan.dest .incluye li::before {
      background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5 12.5l4.5 4.5L19 7.5' fill='none' stroke='%238fb0ff' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 11px no-repeat, rgb(143 176 255 / .16); }
    .plan.dest .btn.out { color: #fff; border-color: rgb(255 255 255 / .45); }
    .plan.dest .btn.out:hover { background: rgb(255 255 255 / .1); border-color: #fff; }
    .plan.dest .btn.primary { color: var(--navy); background: #fff; box-shadow: 0 10px 24px -10px rgb(0 0 0 / .6); }

    /* ── Tabla comparativa ── */
    .tabla-wrap { overflow-x: auto; background: #fff; border: 1.5px solid var(--line); border-radius: 18px; }
    .comp { width: 100%; border-collapse: separate; border-spacing: 0; font-size: .88rem; }
    .comp th, .comp td { padding: 15px 18px; text-align: center; border-bottom: 1px solid #edf1f9; }
    .comp thead th { font-size: .68rem; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; color: #b4c0de; background: linear-gradient(180deg, var(--navy), var(--navy-2)); border-bottom: 0; }
    .comp th:first-child, .comp td:first-child { position: sticky; left: 0; z-index: 1; text-align: left; background: #fff; }
    .comp thead th:first-child { background: var(--navy); }
    .comp tbody tr:hover td { background: #f6f8fe; } .comp tbody tr:last-child td { border-bottom: 0; }
    .ok { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; color: var(--blue); background: rgb(29 78 216 / .1); }
    .no { color: #c4cde2; }

    /* ── Servicios ── */
    .cat { margin: 30px 0 14px; font-size: 1.05rem; font-weight: 700; letter-spacing: -.01em; }
    .servs { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 18px; }
    .serv { position: relative; overflow: hidden; display: flex; flex-direction: column; gap: 10px; padding: 26px; background: #fff; border: 1.5px solid var(--line); border-radius: 18px; }
    .seccion.alt .serv { background: var(--bg); }
    .serv::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 3px; background: linear-gradient(90deg, var(--red), var(--blue-2)); transform: scaleX(0); transform-origin: left; transition: transform .4s var(--ease); }
    .serv:hover { transform: translateY(-4px); border-color: rgb(29 78 216 / .5); box-shadow: 0 24px 44px -28px rgb(10 26 58 / .5); } .serv:hover::before { transform: scaleX(1); }
    .serv h4 { margin: 0; font-size: 1.05rem; font-weight: 700; letter-spacing: -.01em; }
    .desc { margin: 0; color: var(--muted); font-size: .88rem; line-height: 1.6; }
    .serv ul { margin: 0; padding-left: 18px; flex: 1; font-size: .86rem; line-height: 1.7; color: #34405e; } .serv li::marker { color: var(--red); }
    .serv-pie { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding-top: 14px; border-top: 1px solid var(--line); }
    .pr { font-weight: 800; letter-spacing: -.01em; }

    /* ── Cómo funciona ── */
    .pasos { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; counter-reset: p; }
    .paso { position: relative; padding: 30px 28px; background: #fff; border: 1px solid var(--line); border-radius: 18px; }
    .paso::after { content: ''; position: absolute; top: 56px; left: calc(100% + 2px); width: 16px; height: 2px; background: var(--line); }
    .paso:last-child::after { display: none; }
    .p-num { display: grid; place-items: center; width: 40px; height: 40px; margin-bottom: 18px; border-radius: 12px; font-weight: 800; color: #fff; background: var(--navy); box-shadow: inset 0 -3px 0 var(--red); }
    .paso h3 { margin: 0 0 8px; font-size: 1.08rem; font-weight: 700; letter-spacing: -.015em; }
    .paso p { margin: 0; color: var(--muted); font-size: .9rem; line-height: 1.65; }

    /* ── Preguntas ── */
    .faq { display: flex; flex-direction: column; gap: 10px; }
    .faq details { background: #fff; border: 1px solid var(--line); border-radius: 14px; transition: border-color .2s, box-shadow .2s; }
    .faq details[open] { border-color: rgb(29 78 216 / .45); box-shadow: 0 18px 36px -26px rgb(10 26 58 / .5); }
    .faq summary { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 18px 22px; list-style: none; font-weight: 600; font-size: .96rem; cursor: pointer; }
    .faq summary::-webkit-details-marker { display: none; }
    .faq summary app-ico { color: var(--muted); transition: transform .3s var(--ease); } .faq details[open] summary app-ico { transform: rotate(180deg); color: var(--blue); }
    .faq details p { margin: 0; padding: 0 22px 20px; color: var(--muted); font-size: .92rem; line-height: 1.7; }

    /* ── Banda final ── */
    .banda { margin-top: 84px; color: #fff; background: radial-gradient(70% 120% at 0% 0%, var(--navy-2), transparent 70%), var(--navy); }
    .banda-in { max-width: 1180px; margin: 0 auto; padding: 56px 20px; display: flex; justify-content: space-between; align-items: center; gap: 28px; flex-wrap: wrap; }
    .banda h2 { margin: 0 0 8px; color: #fff; } .banda p { margin: 0; color: #b4c0de; }
    .banda-cta { display: flex; gap: 12px; flex-wrap: wrap; }

    /* ── Pie ── */
    .pie { position: relative; padding: 32px 20px 110px; color: #b4c0de; background: #071330; font-size: .86rem; }
    .pie::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 4px; background: linear-gradient(90deg, var(--red) 0 33.34%, #f5f7fb 33.34% 66.67%, var(--red) 66.67%); }
    .pie-in { max-width: 1180px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
    .pie-marca { display: flex; align-items: center; gap: 10px; } .pie b { color: #fff; font-size: 1rem; }

    /* ── Pedido (carrito) ── */
    .barra { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 55; display: flex; align-items: center; gap: 12px; width: min(640px, calc(100% - 24px));
      padding: 10px 12px 10px 20px; color: #fff; background: var(--navy); border-radius: 16px; box-shadow: 0 24px 48px -16px rgb(10 26 58 / .7), 0 0 0 1px rgb(255 255 255 / .08); animation: subir .4s var(--ease) both; }
    @keyframes subir { from { opacity: 0; transform: translate(-50%, 20px); } to { opacity: 1; transform: translate(-50%, 0); } }
    .b-info { flex: 1; display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: .9rem; } .b-info app-ico { color: var(--sky); }
    .b-info i { width: 1px; height: 16px; background: rgb(255 255 255 / .25); }

    /* ── Flotantes ── */
    .fabs { position: fixed; right: 20px; bottom: 20px; z-index: 50; display: flex; flex-direction: column; align-items: flex-end; gap: 12px; }
    .fab { display: inline-flex; align-items: center; gap: 9px; border: 0; cursor: pointer; font: inherit; font-size: .88rem; font-weight: 600; text-decoration: none; color: #fff; border-radius: 14px; transition: transform .3s cubic-bezier(.34, 1.4, .64, 1), opacity .3s, box-shadow .3s; }
    .fab.up { justify-content: center; width: 46px; height: 46px; background: var(--navy); box-shadow: inset 0 -3px 0 var(--red), 0 12px 26px -10px rgb(10 26 58 / .7); opacity: 0; transform: translateY(16px) scale(.7); pointer-events: none; }
    .fab.up.show { opacity: 1; transform: none; pointer-events: auto; } .fab.up:hover { transform: translateY(-3px); }
    .fab.wa { height: 50px; padding: 0 20px 0 16px; background: linear-gradient(135deg, var(--blue), var(--blue-2)); box-shadow: 0 14px 30px -10px rgb(29 78 216 / .75); } .fab.wa:hover { transform: translateY(-3px); }
    body:has(.barra) .fabs, :host:has(.barra) .fabs { bottom: 92px; }

    /* ── Responsive ── */
    @media (max-width: 1000px) {
      .hero-in { grid-template-columns: 1fr; gap: 56px; padding: 52px 20px 72px; } .mock { margin: 0 auto; } .mk-toast { left: 8px; } .links { display: none; }
      .paso::after { display: none; }
    }
    @media (max-width: 600px) {
      .acciones .btn.ghost { display: none; } .seccion { padding-top: 64px; } .barra { padding-left: 14px; } .fab.wa span { display: none; } .fab.wa { width: 50px; padding: 0; justify-content: center; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
      .rv { opacity: 1; translate: none; }
    }
  `],
})
export class InicioPage implements OnInit, OnDestroy {
  private readonly api: PublicoService = inject(PublicoService);
  private readonly rt: PublicoRealtimeService = inject(PublicoRealtimeService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);

  readonly datos = signal<CatalogoPub | null>(null);
  readonly error = signal<string>('');
  readonly carrito: CarritoService = inject(CarritoService);
  readonly tipo = this.carrito.tipo;
  readonly periodo = this.carrito.periodo;
  readonly sel = signal<string>('');
  readonly totalEstimado = computed<number>(() => {
    const d = this.datos();
    return d ? this.carrito.resumen(d).total : 0;
  });

  /** Solo UI */
  readonly scrolled = signal<boolean>(false);
  readonly fab = signal<boolean>(false);

  readonly confianza = [
    { i: 'shield', t: 'Accesos por rol' },
    { i: 'bolt', t: 'Avisos en tiempo real' },
    { i: 'lock', t: 'Pago en línea seguro' },
  ];

  readonly ventajas = [
    { i: 'search', t: 'Contrataciones al día', d: 'Busca y filtra contrataciones del Estado con sus fechas y documentos, actualizadas automáticamente.' },
    { i: 'users', t: 'Cotiza en equipo', d: 'Asigna cada contratación a un compañero y sigue su estado hasta cotizarla.' },
    { i: 'bolt', t: 'Avisos en tiempo real', d: 'Cada asignación le llega a quien corresponde al instante, sin recargar la página.' },
    { i: 'shield', t: 'Accesos controlados', d: 'Cada usuario ve solo los módulos y acciones que le habilitas.' },
  ];

  readonly pasos = [
    { t: 'Elige tu paquete', d: 'Selecciona uno o varios paquetes, la modalidad y el periodo. Verás el total antes de pagar.' },
    { t: 'Recibe tu acceso', d: 'Al confirmarse el pago te enviamos un correo con un enlace seguro para crear tu clave.' },
    { t: 'Cotiza con tu equipo', d: 'Ingresa, revisa las contrataciones y asígnalas a tu equipo para cotizarlas a tiempo.' },
  ];

  readonly faq = [
    { q: '¿Puedo contratar más de un paquete?', a: 'Sí. Puedes elegir varios paquetes, planes y servicios en un mismo pedido y pagarlos en un solo cobro.' },
    { q: '¿Qué diferencia hay entre "Solo visualizar" y "Visualizar y cotizar"?', a: 'Con "Solo visualizar" puedes buscar y revisar contrataciones y sus documentos. Con "Visualizar y cotizar" además puedes asignarlas y gestionarlas con tu equipo.' },
    { q: '¿Cómo recibo mi acceso?', a: 'Al confirmarse el pago te enviamos un correo con un enlace de un solo uso para crear tu clave. Tu usuario es el correo que registraste.' },
    { q: '¿Puedo agregar usuarios a mi empresa?', a: 'Sí. Cada plan para empresas incluye una cantidad de usuarios y puedes sumar usuarios adicionales cuando los necesites.' },
    { q: '¿Puedo mejorar o renovar mi plan después?', a: 'Sí. Desde "Mi cuenta" puedes renovar, pasar de visualizar a cotizar, agregar paquetes, servicios o usuarios.' },
    { q: '¿Es seguro el pago?', a: 'Los datos de tu tarjeta los procesa el proveedor de pagos y nunca pasan por nuestros servidores.' },
  ];

  readonly planes = computed<PlanPub[]>(() => this.datos()?.planes ?? []);
  readonly beneficios = computed<BeneficioPub[]>(() => this.datos()?.beneficios ?? []);
  readonly servicios = computed<ServicioPub[]>(() => this.datos()?.servicios ?? []);
  readonly nombre = computed<string>(() => this.cfg('sitio_nombre') || 'COTI');
  readonly inicial = computed<string>(() => this.nombre().charAt(0).toUpperCase());

  /** Los 3 paquetes; solo se muestran los que tienen algo en venta. */
  readonly paquetes = computed<Paquete[]>(() =>
    BASE.map((b) => ({
      ...b,
      nombre: this.cfg(`paq_${b.id}_nombre`) || b.nombre,
      desc: this.cfg(`paq_${b.id}_desc`) || b.desc,
      planes: this.planes().filter((p) => p.modulos.length === 1 && p.modulos[0] === b.id),
      servicios: this.servicios().filter((s) => s.modulo === b.id),
    })).filter((p) => p.planes.length || p.servicios.length));

  readonly actual = computed<Paquete | null>(() =>
    this.paquetes().find((p) => p.id === this.sel()) ?? this.paquetes()[0] ?? null);

  /** Planes que habilitan 2 o más módulos. */
  readonly combos = computed<PlanPub[]>(() => this.planes().filter((p) => p.modulos.length > 1));
  /** Servicios que no pertenecen a ningún paquete. */
  readonly generales = computed<ServicioPub[]>(() => this.servicios().filter((s) => !s.modulo));
  readonly hayPlanes = computed<boolean>(() => this.paquetes().length > 0 || this.combos().length > 0);

  ngOnInit(): void {
    this.cargarCatalogo();
    // Tiempo real: planes, precios, beneficios, servicios y textos cambian solos en la portada
    this.rt.iniciar();
    this.rt.cambios('catalogo').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargarCatalogo());
  }

  ngOnDestroy(): void { this.rt.detener(); }

  private cargarCatalogo(): void {
    this.api.catalogo().subscribe({
      next: (d) => { this.datos.set(d); this.error.set(''); },
      error: () => this.error.set('No pudimos cargar la información. Intenta de nuevo en unos minutos.'),
    });
  }

  onScroll(): void {
    const y = window.scrollY;
    this.scrolled.set(y > 24);
    this.fab.set(y > 600);
  }

  arriba(): void { window.scrollTo({ top: 0, behavior: 'smooth' }); }

  cfg(k: string): string { return this.datos()?.config[k] ?? ''; }

  ir(id: string): void { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }

  grupos(items: ServicioPub[]): { categoria: string; items: ServicioPub[] }[] {
    const mapa = new Map<string, ServicioPub[]>();
    for (const s of items) mapa.set(s.categoria, [...(mapa.get(s.categoria) ?? []), s]);
    return [...mapa].map(([categoria, lista]) => ({ categoria, items: lista }));
  }

  soles(n: number): string {
    return 'S/ ' + n.toLocaleString('es-PE', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }

  private monto(p: PlanPub, concepto: string, periodo: string): number | null {
    const f = p.precios.find((x) => x.tipo_cuenta === this.tipo() && x.concepto === concepto && x.periodo === periodo);
    return f ? f.monto : null;
  }

  lineasPrecio(p: PlanPub): Linea[] {
    const out: Linea[] = [];
    const defs: [string, string][] = [['ver', 'Solo visualizar'], ['cotizar', 'Visualizar y cotizar']];
    for (const [concepto, label] of defs) {
      const m = this.monto(p, concepto, this.periodo());
      if (m === null) continue;
      let nota = '';
      if (this.periodo() === 'anual') {
        nota = `≈ ${this.soles(m / 12)} al mes`;
        const mensual = this.monto(p, concepto, 'mensual');
        if (mensual !== null && mensual > 0 && m < mensual * 12) {
          nota += ` · ahorras ${Math.round((1 - m / (mensual * 12)) * 100)}%`;
        }
      }
      out.push({ concepto, label, monto: m, nota });
    }
    return out;
  }

  notasEmpresa(p: PlanPub): string[] {
    const n = [`Incluye ${p.usuarios_incluidos} ${p.usuarios_incluidos === 1 ? 'usuario' : 'usuarios'}`];
    const extra = this.monto(p, 'usuario_extra', this.periodo());
    if (extra !== null) n.push(`Usuario adicional: ${this.soles(extra)} por ${this.periodo() === 'anual' ? 'año' : 'mes'}`);
    return n;
  }

  modulosDe(p: PlanPub): string[] { return p.modulos.map((m) => NOMBRE_MODULO[m] ?? m); }

  incluye(p: PlanPub): string[] {
    return this.beneficios()
      .filter((b) => !!p.beneficios[b.id])
      .map((b) => (b.tipo === 'check' ? b.nombre : `${b.nombre}: ${p.beneficios[b.id]}`));
  }

  /** Valor del beneficio para un plan ('' = no incluido). */
  valor(p: PlanPub, b: BeneficioPub): string { return p.beneficios[b.id] ?? ''; }

  private contacto(texto: string): string {
    const wa = this.cfg('contacto_whatsapp');
    if (wa) return `https://wa.me/${wa}?text=${encodeURIComponent(texto)}`;
    const mail = this.cfg('contacto_correo');
    if (mail) return `mailto:${mail}?subject=${encodeURIComponent('Consulta')}&body=${encodeURIComponent(texto)}`;
    return '';
  }

  modosPlan(p: PlanPub): { modo: ModoPlan; label: string }[] {
    const defs: { modo: ModoPlan; label: string }[] = [
      { modo: 'ver', label: 'Solo visualizar' }, { modo: 'cotizar', label: 'Visualizar y cotizar' },
    ];
    return defs.filter((d) => this.monto(p, d.modo, this.periodo()) !== null);
  }

  enCarrito(p: PlanPub, modo: ModoPlan): boolean { return this.carrito.enCarrito(p.id, modo); }

  alternarPlan(p: PlanPub, modo: ModoPlan): void { this.carrito.alternarPlan(p.id, modo); }

  ctaPlan(p: PlanPub): string {
    const quien = this.tipo() === 'empresa' ? 'empresa' : 'persona natural';
    return this.contacto(`Hola, quiero contratar el ${p.nombre} (${quien}, ${this.periodo()}).`);
  }

  /** Para los botones de contacto general. */
  ctaGeneral(): string {
    return this.contacto('Hola, quisiera más información.');
  }
}