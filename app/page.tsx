'use client'

import { ChangeEvent, DragEvent, useEffect, useRef, useState } from 'react'
import {
  Download,
  ImageIcon,
  Loader2,
  Plus,
  Sparkles,
  Upload,
  X,
} from 'lucide-react'
import Image from 'next/image'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

const BUILT_IN_PROMPT =
  "Please place the provided furniture items naturally into the interior room photo. Maintain the original room's lighting, perspective, and architectural details. Make the furniture fit naturally with appropriate shadows and reflections. Keep the room's overall style coherent."

const MAX_FURNITURE_IMAGES = 4
const MAX_FILE_SIZE = 5 * 1024 * 1024

type UploadStatus = 'idle' | 'uploading' | 'uploaded' | 'error'

type UploadedImage = {
  id: string
  file: File
  previewUrl: string
  uploadFileId: string | null
  status: UploadStatus
  error: string | null
}

type GenerationState = {
  imageUrl: string | null
  error: string | null
  isLoading: boolean
  statusText: string
}

const initialGenerationState: GenerationState = {
  imageUrl: null,
  error: null,
  isLoading: false,
  statusText: '',
}

function createLocalId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

async function compressImageIfNeeded(file: File) {
  if (file.size <= MAX_FILE_SIZE) {
    return file
  }

  const imageUrl = URL.createObjectURL(file)

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new window.Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('Unable to read image for compression'))
      img.src = imageUrl
    })

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.width * 0.5))
    canvas.height = Math.max(1, Math.round(image.height * 0.5))

    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Unable to initialize canvas for compression')
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height)

    const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => {
          if (value) {
            resolve(value)
            return
          }

          reject(new Error('Unable to compress image'))
        },
        mimeType,
        0.9
      )
    })

    const fileName = file.name.replace(/\.[^.]+$/, '')
    const extension = mimeType === 'image/png' ? 'png' : 'jpg'

    return new File([blob], `${fileName}.${extension}`, {
      type: mimeType,
      lastModified: Date.now(),
    })
  } finally {
    URL.revokeObjectURL(imageUrl)
  }
}

async function uploadToDify(file: File) {
  const apiKey = process.env.NEXT_PUBLIC_INTERIOR_API_KEY

  if (!apiKey) {
    throw new Error('Missing NEXT_PUBLIC_INTERIOR_API_KEY')
  }

  const formData = new FormData()
  formData.append('file', file)
  formData.append('user', `user-${Date.now()}`)

  const response = await fetch('/api/dify/upload', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
    },
    body: formData,
  })

  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    throw new Error(payload?.error || 'Upload failed')
  }

  const uploadFileId =
    payload?.id || payload?.file_id || payload?.data?.id || payload?.data?.file_id

  if (!uploadFileId || typeof uploadFileId !== 'string') {
    throw new Error('Upload succeeded but no file id was returned')
  }

  return uploadFileId
}

function extractResultImageUrl(payload: Record<string, unknown>) {
  const outputs =
    (payload.outputs as Record<string, unknown> | undefined) ||
    ((payload.metadata as Record<string, unknown> | undefined)?.outputs as
      | Record<string, unknown>
      | undefined)

  const candidates = [
    outputs?.image_url,
    outputs?.image,
    outputs?.url,
    payload.answer,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }

  return null
}

export default function Page() {
  const roomInputRef = useRef<HTMLInputElement>(null)
  const furnitureInputRef = useRef<HTMLInputElement>(null)
  const latestRoomPreviewRef = useRef<string | null>(null)
  const latestFurniturePreviewRef = useRef<string[]>([])

  const [roomImage, setRoomImage] = useState<UploadedImage | null>(null)
  const [furnitureImages, setFurnitureImages] = useState<UploadedImage[]>([])
  const [generation, setGeneration] = useState<GenerationState>(initialGenerationState)
  const [isRoomDragging, setIsRoomDragging] = useState(false)
  const [isFurnitureDragging, setIsFurnitureDragging] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)

  useEffect(() => {
    const nextRoomPreview = roomImage?.previewUrl ?? null
    const nextFurniturePreviews = furnitureImages.map((item) => item.previewUrl)

    if (
      latestRoomPreviewRef.current &&
      latestRoomPreviewRef.current !== nextRoomPreview
    ) {
      URL.revokeObjectURL(latestRoomPreviewRef.current)
    }

    for (const url of latestFurniturePreviewRef.current) {
      if (!nextFurniturePreviews.includes(url)) {
        URL.revokeObjectURL(url)
      }
    }

    latestRoomPreviewRef.current = nextRoomPreview
    latestFurniturePreviewRef.current = nextFurniturePreviews
  }, [roomImage?.previewUrl, furnitureImages])

  useEffect(() => {
    return () => {
      if (latestRoomPreviewRef.current) {
        URL.revokeObjectURL(latestRoomPreviewRef.current)
      }

      for (const url of latestFurniturePreviewRef.current) {
        URL.revokeObjectURL(url)
      }
    }
  }, [])

  async function handleRoomFile(file: File) {
    const nextPreviewUrl = URL.createObjectURL(file)

    if (roomImage?.previewUrl) {
      URL.revokeObjectURL(roomImage.previewUrl)
    }

    setGeneration(initialGenerationState)
    setRoomImage({
      id: createLocalId(),
      file,
      previewUrl: nextPreviewUrl,
      uploadFileId: null,
      status: 'uploading',
      error: null,
    })

    try {
      const compressedFile = await compressImageIfNeeded(file)
      if (compressedFile !== file) {
        URL.revokeObjectURL(nextPreviewUrl)
      }

      const previewUrl =
        compressedFile === file ? nextPreviewUrl : URL.createObjectURL(compressedFile)
      const uploadFileId = await uploadToDify(compressedFile)

      setRoomImage({
        id: createLocalId(),
        file: compressedFile,
        previewUrl,
        uploadFileId,
        status: 'uploaded',
        error: null,
      })
    } catch (error) {
      setRoomImage((current) =>
        current
          ? {
              ...current,
              status: 'error',
              error: error instanceof Error ? error.message : 'Room upload failed',
            }
          : current
      )
    }
  }

  async function handleFurnitureFiles(files: File[]) {
    if (!files.length) {
      return
    }

    const nextFiles = files.slice(0, MAX_FURNITURE_IMAGES - furnitureImages.length)
    if (!nextFiles.length) {
      return
    }

    setGeneration(initialGenerationState)

    const placeholders = nextFiles.map((file) => ({
      id: createLocalId(),
      file,
      previewUrl: URL.createObjectURL(file),
      uploadFileId: null,
      status: 'uploading' as const,
      error: null,
    }))

    setFurnitureImages((current) => [...current, ...placeholders])

    await Promise.all(
      placeholders.map(async (placeholder) => {
        try {
          const compressedFile = await compressImageIfNeeded(placeholder.file)
          if (compressedFile !== placeholder.file) {
            URL.revokeObjectURL(placeholder.previewUrl)
          }

          const previewUrl =
            compressedFile === placeholder.file
              ? placeholder.previewUrl
              : URL.createObjectURL(compressedFile)

          const uploadFileId = await uploadToDify(compressedFile)

          setFurnitureImages((current) =>
            current.map((item) =>
              item.id === placeholder.id
                ? {
                    ...item,
                    file: compressedFile,
                    previewUrl,
                    uploadFileId,
                    status: 'uploaded',
                    error: null,
                  }
                : item
            )
          )
        } catch (error) {
          setFurnitureImages((current) =>
            current.map((item) =>
              item.id === placeholder.id
                ? {
                    ...item,
                    status: 'error',
                    error:
                      error instanceof Error ? error.message : 'Furniture upload failed',
                  }
                : item
            )
          )
        }
      })
    )
  }

  function removeFurnitureImage(id: string) {
    setFurnitureImages((current) => {
      const target = current.find((item) => item.id === id)
      if (target) {
        URL.revokeObjectURL(target.previewUrl)
      }

      return current.filter((item) => item.id !== id)
    })
    setGeneration(initialGenerationState)
  }

  function clearRoomImage() {
    if (roomImage?.previewUrl) {
      URL.revokeObjectURL(roomImage.previewUrl)
    }

    setRoomImage(null)
    setGeneration(initialGenerationState)
  }

  async function handleGenerate() {
    if (!roomImage?.uploadFileId) {
      setGeneration({
        imageUrl: null,
        error: 'Upload the room image before generating',
        isLoading: false,
        statusText: '',
      })
      return
    }

    const uploadedFurniture = furnitureImages.filter((item) => item.uploadFileId)
    if (!uploadedFurniture.length) {
      setGeneration({
        imageUrl: null,
        error: 'Upload at least one furniture image before generating',
        isLoading: false,
        statusText: '',
      })
      return
    }

    const apiKey = process.env.NEXT_PUBLIC_INTERIOR_API_KEY
    const endpoint = process.env.NEXT_PUBLIC_DIFY_API_ENDPOINT

    if (!apiKey || !endpoint) {
      setGeneration({
        imageUrl: null,
        error:
          'Missing NEXT_PUBLIC_INTERIOR_API_KEY or NEXT_PUBLIC_DIFY_API_ENDPOINT',
        isLoading: false,
        statusText: '',
      })
      return
    }

    setGeneration({
      imageUrl: null,
      error: null,
      isLoading: true,
      statusText: 'Generating interior concept...',
    })

    try {
      const response = await fetch('/api/dify/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'x-api-endpoint': endpoint,
        },
        body: JSON.stringify({
          query: BUILT_IN_PROMPT,
          response_mode: 'streaming',
          user: `user-${Date.now()}`,
          inputs: {
            prompt: BUILT_IN_PROMPT,
            inputimage: [
              {
                type: 'image',
                transfer_method: 'local_file',
                upload_file_id: roomImage.uploadFileId,
              },
              ...uploadedFurniture.map((item) => ({
                type: 'image',
                transfer_method: 'local_file',
                upload_file_id: item.uploadFileId,
              })),
            ],
          },
        }),
      })

      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.error || 'Generation request failed')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let finalImageUrl: string | null = null
      let pendingEvent = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split('\n\n')
        buffer = chunks.pop() || ''

        for (const chunk of chunks) {
          const lines = chunk
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)

          if (!lines.length) {
            continue
          }

          let dataPayload = ''

          for (const line of lines) {
            if (line.startsWith('event:')) {
              pendingEvent = line.slice(6).trim()
            }

            if (line.startsWith('data:')) {
              dataPayload += line.slice(5).trim()
            }
          }

          if (!dataPayload || dataPayload === '[DONE]') {
            continue
          }

          const parsed = JSON.parse(dataPayload) as Record<string, unknown>

          if (typeof parsed.error === 'string' && parsed.error) {
            throw new Error(parsed.error)
          }

          const eventName =
            (typeof parsed.event === 'string' && parsed.event) || pendingEvent

          if (eventName === 'message' || eventName === 'agent_message') {
            setGeneration((current) => ({
              ...current,
              statusText: 'Refining placement and lighting...',
            }))
          }

          if (eventName === 'message_end' || eventName === 'workflow_finished') {
            finalImageUrl = extractResultImageUrl(parsed)
          }
        }
      }

      if (!finalImageUrl) {
        throw new Error('Generation completed but no image URL was returned')
      }

      setGeneration({
        imageUrl: finalImageUrl,
        error: null,
        isLoading: false,
        statusText: '',
      })
    } catch (error) {
      setGeneration({
        imageUrl: null,
        error: error instanceof Error ? error.message : 'Generation failed',
        isLoading: false,
        statusText: '',
      })
    }
  }

  async function handleDownload() {
    if (!generation.imageUrl) {
      return
    }

    setIsDownloading(true)

    try {
      const response = await fetch(
        `/api/image-proxy?url=${encodeURIComponent(generation.imageUrl)}`
      )

      if (!response.ok) {
        throw new Error('Unable to download generated image')
      }

      const blob = await response.blob()
      const downloadUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = downloadUrl
      link.download = `interior-design-${Date.now()}.png`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(downloadUrl)
    } catch (error) {
      setGeneration((current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Download failed',
      }))
    } finally {
      setIsDownloading(false)
    }
  }

  function handleRoomInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (file) {
      void handleRoomFile(file)
    }
    event.target.value = ''
  }

  function handleFurnitureInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || [])
    if (files.length) {
      void handleFurnitureFiles(files)
    }
    event.target.value = ''
  }

  function handleRoomDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsRoomDragging(false)
    const file = event.dataTransfer.files?.[0]
    if (file) {
      void handleRoomFile(file)
    }
  }

  function handleFurnitureDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsFurnitureDragging(false)
    const files = Array.from(event.dataTransfer.files || [])
    if (files.length) {
      void handleFurnitureFiles(files)
    }
  }

  const hasUploadingFiles =
    roomImage?.status === 'uploading' ||
    furnitureImages.some((item) => item.status === 'uploading')

  const canGenerate =
    !generation.isLoading &&
    !hasUploadingFiles &&
    roomImage?.status === 'uploaded' &&
    furnitureImages.some((item) => item.status === 'uploaded')

  const furnitureSlots = Array.from({ length: MAX_FURNITURE_IMAGES }, (_, index) => {
    return furnitureImages[index] || null
  })

  return (
    <main className="min-h-full bg-[linear-gradient(180deg,#f8f8f7_0%,#f3f1ee_100%)]">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
        <section className="rounded-3xl border border-border/70 bg-background/90 p-6 shadow-sm backdrop-blur md:p-8">
          <div className="max-w-3xl space-y-3">
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-muted-foreground">
              Interior Design Furniture Placement
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
              Stage furniture inside a real room before you generate.
            </h1>
            <p className="text-sm leading-6 text-muted-foreground md:text-base">
              Upload one base room photo and up to four furniture cutouts. Files are
              uploaded immediately, then combined into a generated composition when
              you run the tool.
            </p>
          </div>
        </section>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          <section className="rounded-3xl border border-border/70 bg-background p-5 shadow-sm md:p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <h2 className="text-xl font-semibold tracking-tight">Uploads</h2>
                <p className="text-sm text-muted-foreground">
                  Drag files in or click any zone to browse.
                </p>
              </div>
              {hasUploadingFiles ? (
                <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Uploading
                </div>
              ) : null}
            </div>

            <div className="mt-6 space-y-6">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <Label className="text-sm font-medium text-foreground">
                    Room Photo
                  </Label>
                  {roomImage ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={clearRoomImage}
                      type="button"
                    >
                      <X className="size-4" />
                      Remove
                    </Button>
                  ) : null}
                </div>

                <input
                  ref={roomInputRef}
                  accept="image/*"
                  className="hidden"
                  onChange={handleRoomInputChange}
                  type="file"
                />

                <div
                  className={cn(
                    'group relative overflow-hidden rounded-2xl border border-dashed bg-muted/30 transition-colors',
                    isRoomDragging
                      ? 'border-foreground bg-muted'
                      : 'border-border hover:border-foreground/50 hover:bg-muted/60'
                  )}
                  onClick={() => roomInputRef.current?.click()}
                  onDragEnter={(event) => {
                    event.preventDefault()
                    setIsRoomDragging(true)
                  }}
                  onDragLeave={(event) => {
                    event.preventDefault()
                    if (event.currentTarget === event.target) {
                      setIsRoomDragging(false)
                    }
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={handleRoomDrop}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      roomInputRef.current?.click()
                    }
                  }}
                >
                  <div className="relative aspect-[16/10] min-h-72 w-full">
                    {roomImage ? (
                      <>
                        <Image
                          alt="Uploaded room preview"
                          className="object-cover"
                          fill
                          sizes="(max-width: 1024px) 100vw, 50vw"
                          src={roomImage.previewUrl}
                          unoptimized
                        />
                        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-gradient-to-t from-black/65 via-black/20 to-transparent px-4 py-4 text-white">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">
                              {roomImage.file.name}
                            </p>
                            <p className="text-xs text-white/80">
                              {roomImage.status === 'uploading'
                                ? 'Uploading room image...'
                                : roomImage.status === 'uploaded'
                                  ? 'Ready for generation'
                                  : roomImage.error || 'Upload failed'}
                            </p>
                          </div>
                          {roomImage.status === 'uploading' ? (
                            <Loader2 className="size-4 shrink-0 animate-spin" />
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
                        <div className="flex size-14 items-center justify-center rounded-full border border-border bg-background text-foreground">
                          <Upload className="size-6" />
                        </div>
                        <div className="space-y-1">
                          <p className="text-base font-medium text-foreground">
                            Upload the base room photo
                          </p>
                          <p className="text-sm text-muted-foreground">
                            Best with a clear, well-lit interior angle.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {roomImage?.error ? (
                  <p className="text-sm text-destructive">{roomImage.error}</p>
                ) : null}
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <Label className="text-sm font-medium text-foreground">
                    Furniture Images
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {furnitureImages.length}/{MAX_FURNITURE_IMAGES} added
                  </p>
                </div>

                <input
                  ref={furnitureInputRef}
                  accept="image/*"
                  className="hidden"
                  multiple
                  onChange={handleFurnitureInputChange}
                  type="file"
                />

                <div
                  className={cn(
                    'rounded-2xl border border-dashed p-3 transition-colors',
                    isFurnitureDragging
                      ? 'border-foreground bg-muted/60'
                      : 'border-border bg-muted/20 hover:border-foreground/50'
                  )}
                  onDragEnter={(event) => {
                    event.preventDefault()
                    setIsFurnitureDragging(true)
                  }}
                  onDragLeave={(event) => {
                    event.preventDefault()
                    if (event.currentTarget === event.target) {
                      setIsFurnitureDragging(false)
                    }
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={handleFurnitureDrop}
                >
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {furnitureSlots.map((item, index) => {
                      const isAddSlot = !item && index === furnitureImages.length
                      const isPlaceholderSlot = !item && !isAddSlot

                      if (item) {
                        return (
                          <div
                            key={item.id}
                            className="group relative aspect-square overflow-hidden rounded-xl border border-border bg-background"
                          >
                            <Image
                              alt={`Furniture upload ${index + 1}`}
                              className="object-cover"
                              fill
                              sizes="(max-width: 640px) 50vw, 12rem"
                              src={item.previewUrl}
                              unoptimized
                            />
                            <button
                              aria-label={`Remove furniture image ${index + 1}`}
                              className="absolute right-2 top-2 inline-flex size-8 items-center justify-center rounded-full bg-black/70 text-white transition hover:bg-black"
                              onClick={() => removeFurnitureImage(item.id)}
                              type="button"
                            >
                              <X className="size-4" />
                            </button>
                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent px-3 py-3 text-white">
                              <p className="truncate text-xs font-medium">
                                {item.file.name}
                              </p>
                              <p className="text-[11px] text-white/80">
                                {item.status === 'uploading'
                                  ? 'Uploading...'
                                  : item.status === 'uploaded'
                                    ? 'Ready'
                                    : item.error || 'Upload failed'}
                              </p>
                            </div>
                            {item.status === 'uploading' ? (
                              <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                                <Loader2 className="size-5 animate-spin text-white" />
                              </div>
                            ) : null}
                          </div>
                        )
                      }

                      if (isAddSlot) {
                        return (
                          <button
                            key={`add-slot-${index}`}
                            className="flex aspect-square flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-background text-muted-foreground transition hover:border-foreground/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={furnitureImages.length >= MAX_FURNITURE_IMAGES}
                            onClick={() => furnitureInputRef.current?.click()}
                            type="button"
                          >
                            <div className="flex size-10 items-center justify-center rounded-full border border-border bg-muted/60">
                              <Plus className="size-4" />
                            </div>
                            <span className="text-xs font-medium">Add item</span>
                          </button>
                        )
                      }

                      if (isPlaceholderSlot) {
                        return (
                          <div
                            key={`placeholder-${index}`}
                            className="flex aspect-square items-center justify-center rounded-xl border border-dashed border-border/70 bg-background/60 text-muted-foreground"
                          >
                            <ImageIcon className="size-5" />
                          </div>
                        )
                      }

                      return null
                    })}
                  </div>
                </div>

                {furnitureImages.some((item) => item.error) ? (
                  <p className="text-sm text-destructive">
                    {furnitureImages.find((item) => item.error)?.error}
                  </p>
                ) : null}
              </div>

              <Button
                className="h-11 w-full rounded-xl text-sm"
                disabled={!canGenerate}
                onClick={handleGenerate}
                type="button"
              >
                {generation.isLoading ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {generation.statusText || 'Generating...'}
                  </>
                ) : (
                  <>
                    <Sparkles className="size-4" />
                    Generate Room
                  </>
                )}
              </Button>
            </div>
          </section>
          <section className="rounded-3xl border border-border/70 bg-background p-5 shadow-sm md:p-6">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <h2 className="text-xl font-semibold tracking-tight">Result</h2>
                <p className="text-sm text-muted-foreground">
                  Your generated scene appears here.
                </p>
              </div>
              {generation.imageUrl ? (
                <Button
                  disabled={isDownloading}
                  onClick={handleDownload}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {isDownloading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Download className="size-4" />
                  )}
                  Download
                </Button>
              ) : null}
            </div>

            <div className="mt-6">
              <div className="overflow-hidden rounded-2xl border border-border bg-muted/20">
                <div className="relative aspect-[4/5] min-h-[28rem] w-full">
                  {generation.imageUrl ? (
                    <Image
                      alt="Generated interior design result"
                      className="object-cover"
                      fill
                      sizes="(max-width: 1024px) 100vw, 45vw"
                      src={`/api/image-proxy?url=${encodeURIComponent(generation.imageUrl)}`}
                      unoptimized
                    />
                  ) : generation.isLoading ? (
                    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
                      <div className="flex size-16 items-center justify-center rounded-full border border-border bg-background">
                        <Loader2 className="size-7 animate-spin text-foreground" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-base font-medium text-foreground">
                          Generating result
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {generation.statusText || 'Waiting for the streamed image...'}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
                      <div className="flex size-16 items-center justify-center rounded-full border border-dashed border-border bg-background text-muted-foreground">
                        <ImageIcon className="size-7" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-base font-medium text-foreground">
                          No generated image yet
                        </p>
                        <p className="max-w-sm text-sm text-muted-foreground">
                          Upload the room and furniture images, then generate to see
                          the composed result here.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {generation.error ? (
                <p className="mt-3 text-sm text-destructive">{generation.error}</p>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </main>
  )
}
