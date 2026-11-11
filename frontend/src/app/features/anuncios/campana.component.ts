import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { TiempoRealService } from '../../core/tiempo-real.service';
import { IconComponent, IconName } from '../../shared/icon.component';
import { AnuncioUsuario, AnunciosService, ICONO_ANUNCIO, haceTxt } from './anuncios.service';

@Component({
  selector: 'app-campana',
  imports: [RouterLink, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'cerrar()' },
  template: `
    <button type="button" class="campana" [class.pulso]="pulso()" aria-label="Novedades" [attr.aria-expanded]="abierto()" (click)="alternar()">
      <app-icon name="bell" [size]="19" />
      @if (sinLeer() > 0) { <span class="n">{{ sinLeer() > 9 ? '9+' : sinLeer() }}</span> }
    </button>

    @if (abierto()) {
      <div class="velo" (click)="cerrar()"></div>
      <div class="panel" role="dialog" aria-label="Novedades">
        <header>
          <b>Novedades</b>
          @if (sinLeer() > 0) { <button type="button" class="todas" (click)="leerTodas()">Marcar todas como leídas</button> }
        </header>
        <ul>
          @for (a of items(); track a.id) {
            <li [class.nuevo]="!a.leido">
              <span class="ico"><app-icon [name]="icono(a.tipo)" [size]="18" /></span>
              <div class="txt">
                <b>{{ a.titulo }}</b>
                @if (a.mensaje) { <p>{{ a.mensaje }}</p> }
                <div class="pie">
                  <small>{{ hace(a.publicado_en) }}</small>
                  @if (a.curso_id) {
                    <a [routerLink]="['/', a.curso_modulo ?? 'perucompras', 'capacitacion', a.curso_id]" (click)="abrir(a)">
                      Ver curso <app-icon name="right" [size]="13" />
                    </a>
                  } @else if (!a.leido) {
                    <button type="button" (click)="abrir(a)">Marcar como leído</button>
                  }
                </div>
              </div>
              @if (!a.leido) { <i class="punto" aria-label="Sin leer"></i> }
            </li>
          } @empty {
            <li class="vacio"><app-icon name="bell" [size]="26" /> Por ahora no hay novedades</li>
          }
        </ul>
      </div>
    }
  `,
  styles: [`
    :host { position: relative; display: inline-flex; }
    .campana { position: relative; display: grid; place-items: center; width: 38px; height: 38px; border: 1px solid #e6e8f0; border-radius: 10px; background: #fff; color: #475569; cursor: pointer; transition: .15s; }
    .campana:hover { background: #eef0ff; border-color: #c7cbe0; color: #4f46e5; }
    .n { position: absolute; top: -6px; right: -6px; display: grid; place-items: center; min-width: 19px; height: 19px; padding: 0 5px; border-radius: 999px; background: #ef4444; color: #fff; font-size: .68rem; font-weight: 700; box-shadow: 0 0 0 2px #fff; }
    .pulso { animation: sonar 1.2s ease-out 2; } @keyframes sonar { 0% { box-shadow: 0 0 0 0 rgb(239 68 68 / .5); } 100% { box-shadow: 0 0 0 14px rgb(239 68 68 / 0); } }
    .velo { position: fixed; inset: 0; z-index: 40; }
    .panel { position: absolute; top: 46px; right: 0; z-index: 50; width: min(390px, 92vw); max-height: 70vh; display: flex; flex-direction: column; overflow: hidden; background: #fff; border: 1px solid #e2e8f4; border-radius: 16px; box-shadow: 0 30px 60px -24px rgb(10 26 58 / .5); }
    header { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid #eef1f8; }
    header b { font-size: .98rem; } .todas { border: 0; background: none; color: #1d4ed8; font: inherit; font-size: .78rem; font-weight: 600; cursor: pointer; }
    ul { list-style: none; margin: 0; padding: 6px; overflow-y: auto; }
    li { position: relative; display: flex; gap: 12px; padding: 12px; border-radius: 12px; }
    li.nuevo { background: #f3f6ff; } li + li { margin-top: 2px; }
    .ico { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; color: #1d4ed8; background: rgb(29 78 216 / .1); flex: none; }
    .txt { flex: 1; min-width: 0; } .txt b { display: block; font-size: .88rem; line-height: 1.35; }
    .txt p { margin: 3px 0 0; color: #475569; font-size: .82rem; line-height: 1.5; }
    .pie { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 8px; } .pie small { color: #94a3b8; font-size: .74rem; }
    .pie a, .pie button { display: inline-flex; align-items: center; gap: 4px; border: 0; background: none; color: #1d4ed8; font: inherit; font-size: .8rem; font-weight: 600; text-decoration: none; cursor: pointer; padding: 0; }
    .punto { position: absolute; top: 16px; right: 12px; width: 8px; height: 8px; border-radius: 50%; background: #1d4ed8; }
    .vacio { flex-direction: column; align-items: center; gap: 8px; padding: 34px 12px; color: #94a3b8; font-size: .88rem; }
    @media (prefers-reduced-motion: reduce) { .pulso { animation: none; } }
  `],
})
export class CampanaComponent implements OnInit {
  private readonly api: AnunciosService = inject(AnunciosService);
  private readonly rt: TiempoRealService = inject(TiempoRealService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);

  readonly items = signal<AnuncioUsuario[]>([]);
  readonly sinLeer = signal<number>(0);
  readonly abierto = signal<boolean>(false);
  readonly pulso = signal<boolean>(false);

  ngOnInit(): void {
    this.cargar();
    // Tiempo real: cuando el superadmin publica un anuncio, la campana se actualiza sola
    this.rt.cambios('anuncios').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargar());
  }

  private cargar(): void {
    this.api.mios().subscribe({
      next: (r) => {
        if (r.sin_leer > this.sinLeer()) {
          this.pulso.set(true);
          setTimeout(() => this.pulso.set(false), 2600);
        }
        this.items.set(r.items);
        this.sinLeer.set(r.sin_leer);
      },
      error: () => undefined,
    });
  }

  icono(t: AnuncioUsuario['tipo']): IconName { return ICONO_ANUNCIO[t]; }
  hace(iso: string | null): string { return haceTxt(iso); }
  alternar(): void { this.abierto.update((v) => !v); }
  cerrar(): void { this.abierto.set(false); }

  abrir(a: AnuncioUsuario): void {
    this.cerrar();
    if (a.leido) return;
    this.api.leer(a.id).subscribe({ error: () => undefined });
    this.items.update((l) => l.map((x) => (x.id === a.id ? { ...x, leido: true } : x)));
    this.sinLeer.update((n) => Math.max(0, n - 1));
  }

  leerTodas(): void {
    this.api.leerTodos().subscribe({ error: () => undefined });
    this.items.update((l) => l.map((x) => ({ ...x, leido: true })));
    this.sinLeer.set(0);
  }
}