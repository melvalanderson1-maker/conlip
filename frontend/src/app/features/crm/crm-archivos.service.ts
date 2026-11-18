import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';
import { Canal } from './crm-whatsapp.service';

export interface ArchivoCrm {
  id: number; nombre: string; mime: string; categoria: 'imagen' | 'audio' | 'video' | 'documento'; tamano: number; creado_en: string;
}

const BASE = `${API}/crm`;

@Injectable({ providedIn: 'root' })
export class ArchivosService {
  private readonly http: HttpClient = inject(HttpClient);

  lista(): Observable<ArchivoCrm[]> { return this.http.get<ArchivoCrm[]>(`${BASE}/archivos`); }
  subir(f: File): Observable<{ id: number }> {
    const d = new FormData();
    d.append('archivo', f);
    return this.http.post<{ id: number }>(`${BASE}/archivos`, d);
  }
  contenido(id: number): Observable<Blob> { return this.http.get(`${BASE}/archivos/${id}/contenido`, { responseType: 'blob' }); }
  borrar(id: number): Observable<unknown> { return this.http.delete(`${BASE}/archivos/${id}`); }
  enviarALead(leadId: number, f: File, canal: Canal, caption: string): Observable<unknown> {
    const d = new FormData();
    d.append('archivo', f);
    d.append('canal', canal);
    d.append('caption', caption);
    return this.http.post(`${BASE}/leads/${leadId}/archivo`, d);
  }
}