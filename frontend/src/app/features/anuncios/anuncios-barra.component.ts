import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { PublicoRealtimeService } from '../../core/publico-realtime.service';
import { IconComponent, IconName } from '../../shared/icon.component';
import { AnuncioPublico, AnunciosService, ICONO_ANUNCIO } from './anuncios.service';

const KEY = 'coti_anuncios_cerrados';

@Component({
  selector: 'app-anuncios-barra',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible(); as a) {
      <div class="barra" role="status">
        <span class="ico"><app-icon [name]="icono(a.tipo)" [size]="16" /></span>
        <b>{{ a.titulo }}</b>
        @if (a.mensaje) { <span class="msg">{{ a.mensaje }}</span> }
        @if (a.curso_id) {
          <button type="button" class="ver" (click)="ver()">Ver curso <app-icon name="right" [size]="14" /></button>
        }
        <button type="button" class="x" aria-label="Cerrar anuncio" (click)="cerrar(a)"><app-icon name="x" [size]="16" /></button>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .barra { position: relative; z-index: 65; display: flex; align-items: center; justify-content: center; gap: 12px; flex-wrap: wrap; padding: 10px 48px 10px 20px; color: #fff; font-size: .88rem; text-align: center;
      background: linear-gradient(90deg, #c8102e, #1d4ed8); animation: baja .4s cubic-bezier(.2, .8, .2, 1); }
    @keyframes baja { from { opacity: 0; transform: translateY(-100%); } }
    .ico { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; background: rgb(255 255 255 / .18); }
    .msg { color: #e7edff; }
    .ver { display: inline-flex; align-items: center; gap: 6px; padding: 5px 14px; border: 1px solid rgb(255 255 255 / .55); border-radius: 999px; background: rgb(255 255 255 / .12); color: #fff; font: inherit; font-size: .8rem; font-weight: 600; cursor: pointer; transition: .15s; }
    .ver:hover { background: #fff; color: #0a1a3a; }
    .x { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 50%; background: transparent; color: #fff; cursor: pointer; }
    .x:hover { background: rgb(255 255 255 / .18); }
    @media (prefers-reduced-motion: reduce) { .barra { animation: none; } }
  `],
})
export class AnunciosBarraComponent implements OnInit {
  private readonly api: AnunciosService = inject(AnunciosService);
  private readonly rt: PublicoRealtimeService = inject(PublicoRealtimeService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);

  readonly lista = signal<AnuncioPublico[]>([]);
  readonly cerrados = signal<number[]>(this.leerCerrados());
  readonly visible = computed<AnuncioPublico | null>(() => this.lista().find((a) => !this.cerrados().includes(a.id)) ?? null);

  ngOnInit(): void {
    this.cargar();
    // Tiempo real: un anuncio nuevo aparece solo, sin recargar la página
    this.rt.cambios('anuncios').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargar());
  }

  private cargar(): void {
    this.api.publicos().subscribe({ next: (l) => this.lista.set(l), error: () => undefined });
  }

  icono(t: AnuncioPublico['tipo']): IconName { return ICONO_ANUNCIO[t]; }

  cerrar(a: AnuncioPublico): void {
    const n = [...this.cerrados(), a.id];
    this.cerrados.set(n);
    try { sessionStorage.setItem(KEY, JSON.stringify(n)); } catch { /* sin almacenamiento */ }
  }

  ver(): void {
    (document.getElementById('cursos') ?? document.getElementById('planes'))?.scrollIntoView({ behavior: 'smooth' });
  }

  private leerCerrados(): number[] {
    try { return JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as number[]; } catch { return []; }
  }
}