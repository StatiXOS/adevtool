import { basename, dirname } from 'path'
import { BlobEntry } from '../blobs/entry'
import { PartitionProps } from '../blobs/props'
import { SelinuxPartResolutions } from '../selinux/contexts'
import { MAKEFILE_HEADER } from '../util/headers'
import { exists } from '../util/fs'
import { avbtool } from '../util/process'

const CONT_SEPARATOR = ' \\\n    '

const SEPOLICY_PARTITION_VARS: { [part: string]: string } = {
  system_ext: 'SYSTEM_EXT_PRIVATE_SEPOLICY_DIRS',
  product: 'PRODUCT_PRIVATE_SEPOLICY_DIRS',
  vendor: 'BOARD_VENDOR_SEPOLICY_DIRS',
  odm: 'BOARD_ODM_SEPOLICY_DIRS',
}

const VINTF_MANIFEST_PARTITION_VARS: { [part: string]: string } = {
  system_ext: 'SYSTEM_EXT_MANIFEST_FILES',
  product: 'PRODUCT_MANIFEST_FILES',
  vendor: 'DEVICE_MANIFEST_FILE', // no 'S'
  odm: 'ODM_MANIFEST_FILES',
}

export interface ModulesMakefile {
  device: string
  vendor: string

  radioFiles?: Array<string>
}

export interface BoardMakefile {
  buildPartitions?: Array<string>
  abOtaPartitions?: Array<string>

  boardInfo?: string
  sepolicyResolutions?: SelinuxPartResolutions
}

export interface DeviceMakefile {
  namespaces?: Array<string>
  copyFiles?: Array<string>
  packages?: Array<string>

  vintfManifestPaths?: Map<string, string>

  props?: PartitionProps
  fingerprint?: string
  enforceRros?: string
}

export interface ProductsMakefile {
  products: Array<string>
}

export interface ProductMakefile {
  baseProductPath: string

  name: string
  model: string
  brand: string
  manufacturer: string

  enforceRros?: string
}

function startBlocks() {
  return [MAKEFILE_HEADER]
}

function finishBlocks(blocks: Array<string>) {
  return `${blocks.join('\n\n')}\n`
}

export function sanitizeBasename(path: string) {
  return basename(path).replaceAll(/[^a-z0-9_\-.]/g, '_')
}

function partPathToMakePath(partition: string, subpath: string) {
  let copyPart = partition == 'system' ? 'PRODUCT_OUT' : `TARGET_COPY_OUT_${partition.toUpperCase()}`
  return `$(${copyPart})/${subpath}`
}

export function blobToFileCopy(entry: BlobEntry, proprietaryDir: string) {
  let destPath = partPathToMakePath(entry.partition, entry.path)
  return `${proprietaryDir}/${entry.srcPath}:${destPath}`
}

export function serializeModulesMakefile(mk: ModulesMakefile) {
  let blocks = startBlocks()
  blocks.push('LOCAL_PATH := $(call my-dir)', `ifeq ($(TARGET_DEVICE),${mk.device})`)

  if (mk.radioFiles != undefined) {
    blocks.push(mk.radioFiles.map(img => `$(call add-radio-file,${img})`).join('\n'))
  }

  blocks.push('endif')
  return finishBlocks(blocks)
}

function addContBlock(blocks: Array<string>, variable: string, items: Array<string> | undefined) {
  if (items != undefined && items.length > 0) {
    blocks.push(`${variable} += \\
    ${items.join(CONT_SEPARATOR)}`)
  }
}

export async function serializeBoardMakefile(
  mk: BoardMakefile,
  avbtoolPath: string,
  factoryPath: string,
) {
  let blocks = startBlocks()

  // TODO: remove this when all ELF prebuilts work with Soong
  blocks.push('BUILD_BROKEN_ELF_PREBUILT_PRODUCT_COPY_FILES := true')

  // Build vendor?
  if (mk.buildPartitions?.includes('vendor')) {
    blocks.push('BOARD_VENDORIMAGE_FILE_SYSTEM_TYPE := ext4')
  }

  // Build DLKM partitions?
  if (mk.buildPartitions?.includes('vendor_dlkm')) {
    blocks.push(`BOARD_USES_VENDOR_DLKMIMAGE := true
BOARD_VENDOR_DLKMIMAGE_FILE_SYSTEM_TYPE := ext4
TARGET_COPY_OUT_VENDOR_DLKM := vendor_dlkm`)
  }
  if (mk.buildPartitions?.includes('odm_dlkm')) {
    blocks.push(`BOARD_USES_ODM_DLKIMAGE := true
BOARD_ODM_DLKIMAGE_FILE_SYSTEM_TYPE := ext4
TARGET_COPY_OUT_ODM_DLKM := odm_dlkm`)
  }

  // Build chained vendor vbmeta?
  if (mk.buildPartitions?.includes('vbmeta_vendor') && (await exists(avbtoolPath))) {
    var vbmeta_path = (factoryPath + "/vbmeta.img")
    let vbmeta_info = await avbtool(avbtoolPath, 'info_image', '--image', vbmeta_path)
    const match = vbmeta_info.match(/Partition Name:\s+vbmeta_vendor\s+Rollback Index Location:\s+(\d+)/);
    let rollbackIndexLocation = match && match[1];

    blocks.push(`BOARD_AVB_VBMETA_VENDOR := vendor
BOARD_AVB_VBMETA_VENDOR_KEY_PATH := external/avb/test/data/testkey_rsa2048.pem
BOARD_AVB_VBMETA_VENDOR_ALGORITHM := SHA256_RSA2048
BOARD_AVB_VBMETA_VENDOR_ROLLBACK_INDEX := $(PLATFORM_SECURITY_PATCH_TIMESTAMP)
BOARD_AVB_VBMETA_VENDOR_ROLLBACK_INDEX_LOCATION := ${rollbackIndexLocation}`)
  }

  addContBlock(blocks, 'AB_OTA_PARTITIONS', mk.abOtaPartitions)

  if (mk.boardInfo != undefined) {
    blocks.push(`TARGET_BOARD_INFO_FILE := ${mk.boardInfo}`)
  }

  if (mk.sepolicyResolutions != undefined) {
    for (let [partition, { sepolicyDirs, missingContexts }] of mk.sepolicyResolutions.entries()) {
      let partVar = SEPOLICY_PARTITION_VARS[partition]
      if (sepolicyDirs.length > 0) {
        addContBlock(blocks, partVar, sepolicyDirs)
      }

      if (missingContexts.length > 0) {
        blocks.push(missingContexts.map(c => `# Missing ${partition} SELinux context: ${c}`).join('\n'))
      }
    }
  }

  return finishBlocks(blocks)
}

export function serializeDeviceMakefile(mk: DeviceMakefile) {
  let blocks = startBlocks()

  addContBlock(blocks, 'PRODUCT_SOONG_NAMESPACES', mk.namespaces)
  addContBlock(blocks, 'PRODUCT_COPY_FILES', mk.copyFiles)
  addContBlock(blocks, 'PRODUCT_PACKAGES', mk.packages)

  if (mk.vintfManifestPaths != undefined) {
    for (let [partition, manifestPath] of mk.vintfManifestPaths.entries()) {
      blocks.push(`${VINTF_MANIFEST_PARTITION_VARS[partition]} += ${manifestPath}`)
    }
  }

  if (mk.props != undefined) {
    for (let [partition, props] of mk.props.entries()) {
      if (props.size == 0) {
        continue
      }

      let propLines = Array.from(props.entries()).map(([k, v]) => `${k}=${v}`)

      blocks.push(`PRODUCT_${partition.toUpperCase()}_PROPERTIES += \\
    ${propLines.join(CONT_SEPARATOR)}`)
    }
  }

  if (mk.fingerprint != undefined) {
    blocks.push(`BUILD_FINGERPRINT := ${mk.fingerprint}`)
  }

  // Note that this is reliant on support in the platform/build repository to take effect:
  // https://review.lineageos.org/c/LineageOS/android_build/+/335515
  if (mk.build_desc != undefined && mk.build_desc.trim() !== "") {
    blocks.push(`PRODUCT_BUILD_PROP_OVERRIDES += BuildDesc="${mk.build_desc}"`)
  }

  if (mk.enforceRros != undefined) {
    blocks.push(`PRODUCT_ENFORCE_RRO_TARGETS := ${mk.enforceRros}`)
  }

  return finishBlocks(blocks)
}

export function serializeProductMakefile(mk: ProductMakefile) {
  let blocks = startBlocks()

  blocks.push(`# Inherit AOSP product
$(call inherit-product, ${mk.baseProductPath})`)

  blocks.push(`# Match stock product info
PRODUCT_NAME := ${mk.name}
PRODUCT_MODEL := ${mk.model}
PRODUCT_BRAND := ${mk.brand}
PRODUCT_MANUFACTURER := ${mk.manufacturer}`)

  if (mk.enforceRros != undefined) {
    blocks.push(`PRODUCT_ENFORCE_RRO_TARGETS := ${mk.enforceRros}`)
  }

  return finishBlocks(blocks)
}

export function serializeProductsMakefile(mk: ProductsMakefile) {
  let blocks = [MAKEFILE_HEADER]

  addContBlock(
    blocks,
    'PRODUCT_MAKEFILES',
    mk.products.map(p => `$(LOCAL_DIR)/${p}.mk`),
  )

  return finishBlocks(blocks)
}
