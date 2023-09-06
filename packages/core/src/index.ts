import type { Plugin } from 'vite'
import type { Config } from 'svgo'

import { normalizePath } from 'vite'
import fg from 'fast-glob'
import getEtag from 'etag'
import cors from 'cors'
import fs from 'fs-extra'
import path from 'pathe'
import SVGCompiler from 'svg-baker'
import { optimize } from 'svgo'
import type { DomInject, FileStats, ViteSvgPluginConfig } from './typing'

const SVG_ICONS_REGISTER_NAME = 'virtual:sprite-svg'
const SVG_ICONS_CLIENT = 'virtual:sprite-svg-names'
const SVG_DOM_ID = '__sprite__svg__dom__'
const XMLNS = 'http://www.w3.org/2000/svg'
const XMLNS_LINK = 'http://www.w3.org/1999/xlink'
export function createSvgIconsPlugin(opt: ViteSvgPluginConfig): Plugin {
  const cache = new Map<string, FileStats>()

  let isBuild = false
  const options = {
    svgoOptions: true,
    symbolId: 'icon-[dir]-[name]',
    inject: 'body-last' as const,
    customDomId: SVG_DOM_ID,
    ...opt,
  }

  let { svgoOptions } = options
  const { symbolId } = options

  if (!symbolId.includes('[name]'))
    throw new Error('SymbolId must contain [name] string!')

  svgoOptions = svgoOptions || typeof svgoOptions === 'boolean' ? {} : svgoOptions

  return {
    name: 'vite:svg-icons',
    configResolved(resolvedConfig) {
      isBuild = resolvedConfig.command === 'build'
    },
    resolveId(id) {
      return [SVG_ICONS_REGISTER_NAME, SVG_ICONS_CLIENT].includes(id) ? id : null
    },

    async load(id, ssr) {
      if (!isBuild && !ssr)
        return null

      const isRegister = id.endsWith(SVG_ICONS_REGISTER_NAME)
      const isClient = id.endsWith(SVG_ICONS_CLIENT)

      if (ssr && !isBuild && (isRegister || isClient))
        return 'export default {}'

      const { code, idSet } = await createModuleCode(
        cache,
        svgoOptions as Config,
        options,
      )
      if (isRegister)
        return code
      if (isClient)
        return idSet
    },
    configureServer: ({ middlewares }) => {
      middlewares.use(cors({ origin: '*' }))
      middlewares.use(async (req, res, next) => {
        const url = normalizePath(req.url!)

        const registerId = `/@id/${SVG_ICONS_REGISTER_NAME}`
        const clientId = `/@id/${SVG_ICONS_CLIENT}`
        if ([clientId, registerId].some(item => url.endsWith(item))) {
          res.setHeader('Content-Type', 'application/javascript')
          res.setHeader('Cache-Control', 'no-cache')
          const { code, idSet } = await createModuleCode(
            cache,
            svgoOptions as Config,
            options,
          )
          const content = url.endsWith(registerId) ? code : idSet

          res.setHeader('Etag', getEtag(content, { weak: true }))
          res.statusCode = 200
          res.end(content)
        }
        else {
          next()
        }
      })
    },
  }
}

export async function createModuleCode(
  cache: Map<string, FileStats>,
  svgoOptions: Config,
  options: ViteSvgPluginConfig,
) {
  const { insertHtml, idSet } = await compilerIcons(cache, svgoOptions, options)

  const xmlns = `xmlns="${XMLNS}"`
  const xmlnsLink = `xmlns:xlink="${XMLNS_LINK}"`
  const html = insertHtml
    .replace(new RegExp(xmlns, 'g'), '')
    .replace(new RegExp(xmlnsLink, 'g'), '')

  const code = `
       if (typeof window !== 'undefined') {
         function loadSvg() {
           var body = document.body;
           var svgDom = document.getElementById('${options.customDomId}');
           if(!svgDom) {
             svgDom = document.createElementNS('${XMLNS}', 'svg');
             svgDom.style.position = 'absolute';
             svgDom.style.width = '0';
             svgDom.style.height = '0';
             svgDom.id = '${options.customDomId}';
             svgDom.setAttribute('xmlns','${XMLNS}');
             svgDom.setAttribute('xmlns:link','${XMLNS_LINK}');
           }
           svgDom.innerHTML = ${JSON.stringify(html)};
           ${domInject(options.inject)}
         }
         if(document.readyState === 'loading') {
           document.addEventListener('DOMContentLoaded', loadSvg);
         } else {
           loadSvg()
         }
      }
        `
  return {
    code: `${code}\nexport default {}`,
    idSet: `export default ${JSON.stringify(Array.from(idSet))}`,
  }
}

function domInject(inject: DomInject = 'body-last') {
  switch (inject) {
    case 'body-first':
      return 'body.insertBefore(svgDom, body.firstChild);'
    default:
      return 'body.insertBefore(svgDom, body.lastChild);'
  }
}

/**
 * Preload all icons in advance
 * @param cache
 * @param options
 */
export async function compilerIcons(
  cache: Map<string, FileStats>,
  svgOptions: Config,
  options: ViteSvgPluginConfig,
) {
  const { iconDirs } = options

  let insertHtml = ''
  const idSet = new Set<string>()

  for (const dir of iconDirs) {
    const svgFilsStats = fg.sync('**/*.svg', {
      cwd: dir,
      stats: true,
      absolute: true,
    })

    for (const entry of svgFilsStats) {
      const { path, stats: { mtimeMs } = {} } = entry
      const cacheStat = cache.get(path)
      let svgSymbol
      let symbolId
      let relativeName = ''

      const getSymbol = async () => {
        relativeName = normalizePath(path).replace(normalizePath(`${dir}/`), '')
        symbolId = createSymbolId(relativeName, options)
        svgSymbol = await compilerIcon(path, symbolId, svgOptions)
        idSet.add(symbolId)
      }

      if (cacheStat) {
        if (cacheStat.mtimeMs !== mtimeMs) {
          await getSymbol()
        }
        else {
          svgSymbol = cacheStat.code
          symbolId = cacheStat.symbolId
          symbolId && idSet.add(symbolId)
        }
      }
      else {
        await getSymbol()
      }

      svgSymbol && cache.set(path, {
        mtimeMs,
        relativeName,
        code: svgSymbol,
        symbolId,
      })
      insertHtml += `${svgSymbol || ''}`
    }
  }
  return { insertHtml, idSet }
}

export async function compilerIcon(
  file: string,
  symbolId: string,
  svgOptions: Config,
): Promise<string | null> {
  if (!file)
    return null

  let content = fs.readFileSync(file, 'utf-8')

  if (svgOptions) {
    const { data } = optimize(content, svgOptions)
    content = data || content
  }

  const svgSymbol = await new SVGCompiler().addSymbol({
    id: symbolId,
    content,
    path: file,
  })
  return svgSymbol.render()
}

export function createSymbolId(name: string, options: ViteSvgPluginConfig) {
  const { symbolId } = options

  if (!symbolId)
    return name

  let id = symbolId
  let fName = name

  const { fileName = '', dirName } = discreteDir(name)
  if (symbolId.includes('[dir]')) {
    id = id.replace(/\[dir\]/g, dirName)
    if (!dirName)
      id = id.replace('--', '-')
    fName = fileName
  }
  id = id.replace(/\[name\]/g, fName)
  return id.replace(path.extname(id), '')
}

export function discreteDir(name: string) {
  if (!normalizePath(name).includes('/')) {
    return {
      fileName: name,
      dirName: '',
    }
  }
  const strList = name.split('/')
  const fileName = strList.pop()
  const dirName = strList.join('-')
  return { fileName, dirName }
}
