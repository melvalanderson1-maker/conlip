import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { API } from '../../core/api';
import { TiempoRealService } from '../../core/tiempo-real.service';

@Injectable({ providedIn: 'root' })
export class ServiciosMenuService {
  private readonly http: HttpClient = inject(HttpClient);
  readonly habilitados = signal<Record<string, boolean>>({});

  constructor() {
    const rt = inject(TiempoRealService);
    // El superadmin enciende o apaga el menú, o cambia un servicio de módulo: se actualiza sin recargar
    for (const tipo of ['catalogo', 'acceso', 'servicio'] as const) {
      rt.cambios(tipo).subscribe(() => this.cargar());
    }
  }

  cargar(): void {
    this.http.get<Record<string, boolean>>(`${API}/mis-servicios/modulos`).subscribe({
      next: (r) => this.habilitados.set(r),
      error: () => this.habilitados.set({}),
    });
  }
}