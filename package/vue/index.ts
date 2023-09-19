import type { App, Component } from 'vue'
import _SvgSprite from './SvgSprite'

const camelizeRE = /-(\w)/g
export const camelize = (str: string): string => str.replace(camelizeRE, (_, c) => c.toUpperCase())

export function withInstall<T extends Component>(options: T) {
  (options as Record<string, unknown>).install = (app: App) => {
    const { name } = options
    if (name) {
      app.component(name, options)
      app.component(camelize(`-${name}`), options)
    }
  }
  return options
}

export const SvgSprite = withInstall(_SvgSprite)
export default SvgSprite
export { svgProps } from './SvgSprite'
export type { SvgProps } from './SvgSprite'
