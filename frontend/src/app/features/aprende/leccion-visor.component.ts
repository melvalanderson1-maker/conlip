import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { API } from '../../core/api';
import { IconComponent } from '../../shared/icon.component';
import { LeccionCarga } from './aprende.service';

type Modo = 'iframe' | 'video' | 'audio' | 'pdf' | 'imagen' | 'texto';
export interface AvanceMedia { actual: number; total: number; forzar: boolean; }

@Component({
  selector: 'app-leccion-visor',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (leccion(); as l) {
      @switch (modo()) {
        @case ('iframe') {
          <div class="escena">
            <iframe [src]="seguro()" [title]="l.titulo" loading="lazy" allowfullscreen
                    allow="accelerometer; encrypted-media; picture-in-picture; fullscreen"
                    referrerpolicy="strict-origin-when-cross-origin"></iframe>
          </div>
        }
        @case ('video') {
          <div class="escena">
            <video controls controlsList="nodownload" playsinline preload="metadata" [src]="url()"
                   (loadedmetadata)="alMeta($event)" (timeupdate)="alTiempo($event)" (pause)="alPausa($event)"
                   (ended)="alFin($event)" (contextmenu)="$event.preventDefault()"></video>
          </div>
        }
        @case ('audio') {
          <div class="tarjeta audio">
            <span class="ico"><app-icon name="headphones" [size]="38" /></span>
            <b>{{ l.titulo }}</b>
            <audio controls controlsList="nodownload" preload="metadata" [src]="url()"
                   (loadedmetadata)="alMeta($event)" (timeupdate)="alTiempo($event)" (pause)="alPausa($event)"
                   (ended)="alFin($event)"></audio>
          </div>
        }
        @case ('pdf') {
          <div class="doc">
            <iframe [src]="seguro()" [title]="l.titulo"></iframe>
            <a class="abrir" [href]="url()" target="_blank" rel="noopener">
              <app-icon name="external" [size]="15" /> Abrir en una pestaña nueva
            </a>
          </div>
        }
        @case ('imagen') {
          <div class="tarjeta"><img [src]="url()" [alt]="l.titulo" /></div>
        }
        @default {
          <article class="tarjeta texto">
            @for (p of parrafos(); track $index) { <p>{{ p }}</p> }
          </article>
        }
      }
    } @else {
      <div class="escena vacio"><app-icon name="play" [size]="46" /><p>Selecciona una lección para empezar</p></div>
    }
  `,
  styles: [`
    :host { display: block; }
    .escena { position: relative; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 14px; background: #05080f; box-shadow: 0 24px 50px -28px rgb(5 8 15 / .9); }
    .escena iframe, .escena video { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #000; }
    .vacio { display: grid; place-content: center; justify-items: center; gap: 10px; color: #8ea3d6; } .vacio p { margin: 0; font-size: .9rem; }
    .tarjeta { padding: 28px; background: #fff; border: 1px solid #e2e8f4; border-radius: 14px; }
    .tarjeta img { display: block; max-width: 100%; margin: 0 auto; border-radius: 10px; }
    .audio { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 40px 24px; text-align: center; }
    .audio .ico { display: grid; place-items: center; width: 84px; height: 84px; border-radius: 50%; color: #1d4ed8; background: rgb(29 78 216 / .1); }
    .audio audio { width: min(100%, 520px); }
    .doc { display: flex; flex-direction: column; gap: 10px; }
    .doc iframe { width: 100%; height: 72vh; min-height: 460px; border: 1px solid #e2e8f4; border-radius: 14px; background: #fff; }
    .abrir { display: inline-flex; align-items: center; gap: 8px; width: fit-content; color: #1d4ed8; font-size: .86rem; font-weight: 600; text-decoration: none; }
    .texto { color: #1f2a44; font-size: 1.02rem; line-height: 1.8; } .texto p { margin: 0 0 1em; white-space: pre-line; } .texto p:last-child { margin: 0; }
  `],
})
export class LeccionVisorComponent {
  private readonly san: DomSanitizer = inject(DomSanitizer);

  readonly leccion = input<LeccionCarga | null>(null);
  /** Segundo desde el que se retoma (donde quedó el alumno). */
  readonly inicio = input<number>(0);
  readonly terminado = output<void>();
  readonly progreso = output<AvanceMedia>();
  private ultimoSeg = -1;

  readonly modo = computed<Modo | null>(() => {
    const l = this.leccion();
    if (!l) return null;
    if (l.fuente === 'youtube' || l.fuente === 'vimeo') return 'iframe';
    switch (l.tipo) {
      case 'video': return 'video';
      case 'audio': return 'audio';
      case 'documento': return 'pdf';
      case 'imagen': return 'imagen';
      default: return 'texto';
    }
  });

  readonly url = computed<string>(() => {
    const l = this.leccion();
    return l?.ruta_media ? `${API}${l.ruta_media}` : (l?.url ?? '');
  });

  /** Solo se usa con direcciones que entrega nuestro servidor (YouTube/Vimeo validados o archivos firmados). */
  readonly seguro = computed<SafeResourceUrl>(() => this.san.bypassSecurityTrustResourceUrl(this.url()));

  readonly parrafos = computed<string[]>(() =>
    (this.leccion()?.contenido ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean));

  alMeta(ev: Event): void {
    const m = ev.target as HTMLMediaElement;
    this.ultimoSeg = -1;
    const ini = this.inicio();
    if (ini > 5 && m.duration && ini < m.duration - 5) m.currentTime = ini;  // retoma donde quedó
  }

  alTiempo(ev: Event): void {
    const m = ev.target as HTMLMediaElement;
    const t = Math.floor(m.currentTime);
    if (t === this.ultimoSeg) return;
    this.ultimoSeg = t;
    this.progreso.emit({ actual: t, total: Math.floor(m.duration || 0), forzar: false });
  }

  alPausa(ev: Event): void {
    const m = ev.target as HTMLMediaElement;
    this.progreso.emit({ actual: Math.floor(m.currentTime), total: Math.floor(m.duration || 0), forzar: true });
  }

  alFin(ev: Event): void {
    const m = ev.target as HTMLMediaElement;
    const total = Math.floor(m.duration || 0);
    this.progreso.emit({ actual: total, total, forzar: true });
    this.terminado.emit();
  }
}