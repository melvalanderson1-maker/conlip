import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../../core/api';

export interface UsuarioAdmin {
  id: number; usuario: string; nombre: string; rol: string; activo: number; permisos: string[];
}
export interface Catalogo {
  modulos: { id: string; nombre: string }[];
  acciones: { id: string; nombre: string }[];
  roles: Record<string, string[]>;
  cupo: number;
  usados: number;
}
export interface UsuarioNuevo {
  usuario: string; nombre: string; clave: string; rol: string; permisos: string[];
}
export interface UsuarioCambios {
  nombre?: string; rol?: string; activo?: boolean; clave?: string; permisos?: string[];
}

@Injectable({ providedIn: 'root' })
export class UsuariosService {
  private readonly http: HttpClient = inject(HttpClient);

  catalogo(): Observable<Catalogo> { return this.http.get<Catalogo>(`${API}/usuarios/catalogo`); }
  listar(): Observable<UsuarioAdmin[]> { return this.http.get<UsuarioAdmin[]>(`${API}/usuarios`); }
  crear(d: UsuarioNuevo): Observable<{ id: number }> { return this.http.post<{ id: number }>(`${API}/usuarios`, d); }
  editar(id: number, d: UsuarioCambios): Observable<{ ok: boolean }> {
    return this.http.patch<{ ok: boolean }>(`${API}/usuarios/${id}`, d);
  }
}