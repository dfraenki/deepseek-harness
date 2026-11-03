# DebateHarness – Plan de producto

## Objetivo
Crear a partir del fork `dfraenki/deepseek-harness` una versión re-brandeada **DebateHarness** enfocada en debates multi-agente: crear contactos/agentes, mantenerlos como una lista de chat y orquestar conversaciones entre varios agentes con propósitos definidos.

## Alcance funcional
1. **Re-branding**
   * Nombre: DebateHarness
   * Tagline: “Agentes que debaten, aprenden y deciden”
   * Actualizar README, BRAND_GUIDELINES, package metadata, UI strings
   * Paleta visual: tono debate – azul/gris con acento ámbar
2. **Contactos de agentes**
   * Presets persistentes con nombre, avatar, descripción y system prompt
   * Lista lateral de “Contactos” que muestra los presets disponibles
   * Creación/edición de contactos desde UI
3. **Chat con contactos**
   * Abrir sesión de chat con un contacto seleccionado
   * Historial por contacto persistido
4. **Debates multi-agente**
   * Creador de debate: seleccionar 2+ agentes, tema, objetivo, formato
   * Modos: debate libre, debate estructurado por rondas, debate con moderador
   * Visualización de conversación entre agentes con separación clara
   * Exportar transcripción y resumen de conclusiones
5. **Orquestación**
   * Perfil `agent-team` habilitado por defecto
   * Herramientas de workflow para encadenar turnos, votación y resumen
   * Presets de debate preconfigurados

## Arquitectura técnica
* Base: monorepo DeepSeek Harness forkado
* Perfil Cordis `debate-harness` que sobrescribe:
  * `ui-brand` → nombre, logo, colores
  * `agent-preset` → plantillas de agentes de debate
  * `ui-sidebar-contacts` → panel de contactos
  * `tool-debate-orchestrator` → herramienta para iniciar debates
* Sin cambios en core packages, todo via plugins y bundles

## Entregables por fase
**Fase 0 – Re-branding**
- Actualizar README, BRAND_GUIDELINES, metadata
- Cambiar favicon/logo y colores primarios en `ui-brand`

**Fase 1 – Contactos**
- Plugin UI `ui-contacts-list` que lista presets
- CRUD de presets vía `preset` service

**Fase 2 – Chat por contacto**
- Integración con `session` para abrir sesión con preset seleccionado

**Fase 3 – Debate**
- Herramienta `debate:start` + UI `ui-debate-room`
- Workflow de rondas y moderación

## Riesgos
- Cambios de nombre en package.json rompen workspaces → se mantiene nombre interno y se rebrandea solo UI/metadata
- Dependencias de plugins experimentales → versionar perfil

## Próximos pasos
1. Confirmar branding: nombre definitivo, colores, logo
2. Crear bundle `debate-harness-profile` con parches Cordis
3. Implementar plugin UI de contactos
4. Prototipo de debate con 2 agentes
