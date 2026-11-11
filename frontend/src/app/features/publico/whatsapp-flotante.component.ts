import { ChangeDetectionStrategy, Component, DestroyRef, Injectable, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';
import { PublicoRealtimeService } from '../../core/publico-realtime.service';

export interface VentasPublicas {
  modo: 'whatsapp' | 'pasarela';
  whatsapp: { numero: string; enlace: string; flotante: boolean };
}

@Injectable({ providedIn: 'root' })
export class VentasPublicoService {
  private readonly http: HttpClient = inject(HttpClient);
  ventas(): Observable<VentasPublicas> { return this.http.get<VentasPublicas>(`${API}/publico/ventas`); }
}

@Component({
  selector: 'app-whatsapp-flotante',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (enlace()) {
      <a class="fab" [href]="enlace()" target="_blank" rel="noopener" aria-label="Escríbenos por WhatsApp">
        <svg viewBox="0 0 24 24" width="30" height="30" fill="#fff" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>
        <span class="txt">¿Dudas? Escríbenos</span>
      </a>
    }
  `,
  styles: [`
    .fab { position: fixed; right: 20px; bottom: 20px; z-index: 60; display: flex; align-items: center; gap: 0; height: 58px; padding: 0 14px; border-radius: 999px; background: #25d366; color: #fff; font-weight: 700; text-decoration: none; box-shadow: 0 16px 32px -12px rgb(0 0 0 / .45); transition: .25s; }
    .fab .txt { max-width: 0; overflow: hidden; white-space: nowrap; transition: .25s; } .fab:hover .txt, .fab:focus-visible .txt { max-width: 170px; margin-left: 10px; }
    @media (max-width: 600px) { .fab { right: 14px; bottom: 14px; } }
  `],
})
export class WhatsappFlotanteComponent implements OnInit {
  private readonly api: VentasPublicoService = inject(VentasPublicoService);
  private readonly rt: PublicoRealtimeService = inject(PublicoRealtimeService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);
  readonly enlace = signal<string>('');

  ngOnInit(): void {
    this.cargar();
    // Tiempo real: si el superadmin cambia el número o apaga el botón, se actualiza solo
    this.rt.cambios('catalogo').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargar());
  }

  private cargar(): void {
    this.api.ventas().subscribe({
      next: (v) => this.enlace.set(v.whatsapp.flotante ? v.whatsapp.enlace : ''),
      error: () => this.enlace.set(''),
    });
  }
}