import { createResizeObserver } from "@solid-primitives/resize-observer"
import { batch, createEffect, createSignal, onMount } from "solid-js"
import { useSearchParams } from "solid-start"
import { RootStore, loadSession } from "~/store"
import { LocalStorageKey, type ChatMessage } from "~/types"
import { setSession, isMobile } from "~/utils"
import MessageContainer from "./MessageContainer"
import InputBox, { defaultInputBoxHeight } from "./InputBox"
import { type FakeRoleUnion, setActionState } from "./SettingAction"
import { defaultEnv } from "~/env"

const SearchParamKey = "q"

export default function () {
  let containerRef: HTMLDivElement
  let controller: AbortController | undefined = undefined
  const [containerWidth, setContainerWidth] = createSignal("init")
  const [inputBoxHeight, setInputBoxHeight] = createSignal(
    defaultInputBoxHeight
  )
  const [searchParams] = useSearchParams()
  const q = searchParams[SearchParamKey]
  const { store, setStore } = RootStore
  onMount(() => {
    createResizeObserver(containerRef, ({ width }, el) => {
      if (el === containerRef) setContainerWidth(`${width}px`)
    })
    setTimeout(() => {
      document.querySelector("#root")?.classList.remove("before")
    })
    document.querySelector("#root")?.classList.add("after")
    loadSession(store.sessionId)
    if (q) sendMessage(q)
  })

  createEffect(() => {
    setSession(store.sessionId, {
      id: store.sessionId,
      lastVisit: Date.now(),
      messages: store.sessionSettings.saveSession
        ? store.messageList
        : store.messageList.filter(m => m.type === "locked"),
      settings: store.sessionSettings
    })
  })

  createEffect(() => {
    localStorage.setItem(
      LocalStorageKey.GLOBALSETTINGS,
      JSON.stringify(store.globalSettings)
    )
  })

  function archiveCurrentMessage() {
    if (store.currentAssistantMessage) {
      batch(() => {
        setStore("messageList", k => [
          ...k,
          {
            role: "assistant",
            content: store.currentAssistantMessage.trim()
          }
        ])
        setStore("currentAssistantMessage", "")
        setStore("loading", false)
      })
      controller = undefined
    }
    !isMobile() && store.inputRef?.focus()
  }

  function stopStreamFetch() {
    if (controller) {
      controller?.abort()
      archiveCurrentMessage()
    }
  }

  function checkAuth(){
   if(isPass()) return true  
    const count = incremental()
    if(Number(count) >= 5 ){
      alert('你的次数已超过限制')
      return false
    }
    return true
  }
  
  function incremental(){
    const count = window.localStorage.getItem('count') || 0
    const res = String(Number(count)+1)
    window.localStorage.setItem('count', res)
    return res
  }
  
  function isPass(){
    const globalSettings = localStorage.getItem(
      LocalStorageKey.GLOBALSETTINGS
    )
    const passwordSet = process.env.PASSWORD || defaultEnv.PASSWORD
    const localKey = process.env.OPENAI_API_KEY || ""
    const isLogin = localKey && globalSettings ? 
      JSON.parse(globalSettings)?.password == passwordSet :
      false
    if(!isLogin && !localKey)return false
    return true
  }
  
  async function validMsg(msg:string){
    const res = await fetch('https://api.itapi.cn/api/badword/query',{
      method:"POST",
      headers:{
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body:`key=1LaPWXd0WR7VT9fHAxSXiTq2gl&word=${msg}`
    }).then(res=>res.json()).then(res=>res.data)
    if(res.conclusion_type !== 1){
      alert('你的内容中有敏感信息！')
      return false
    }
    return true
  }
  
  async function sendMessage(value?: string, fakeRole?: FakeRoleUnion) {
    const inputValue = value ?? store.inputContent
    if (!inputValue) return
    if(!await validMsg(inputValue)) return
    if(!checkAuth())return 

    setStore("inputContent", "")
    if (fakeRole === "assistant") {
      setActionState("fakeRole", "normal")
      if (
        store.messageList.at(-1)?.role !== "user" &&
        store.messageList.at(-2)?.role === "user"
      ) {
        setStore("messageList", store.messageList.length - 1, {
          role: "assistant",
          content: inputValue
        })
      } else if (store.messageList.at(-1)?.role === "user") {
        setStore("messageList", k => [
          ...k,
          {
            role: "assistant",
            content: inputValue
          }
        ])
      } else {
        setStore("messageList", k => [
          ...k,
          {
            role: "user",
            content: inputValue
          }
        ])
      }
    } else if (fakeRole === "user") {
      setActionState("fakeRole", "normal")
      setStore("messageList", k => [
        ...k,
        {
          role: "user",
          content: inputValue
        }
      ])
    } else {
      try {
        setStore("messageList", k => [
          ...k,
          {
            role: "user",
            content: inputValue
          }
        ])
        if (store.remainingToken < 0) {
          throw new Error(
            store.sessionSettings.continuousDialogue
              ? "本次对话过长，请清除之前部分对话或者缩短当前提问。"
              : "提问太长了，请缩短。"
          )
        }
        setStore("loading", true)
        controller = new AbortController()
        // 在关闭连续对话时，有效上下文只包含了锁定的对话。
        await fetchGPT(
          store.sessionSettings.continuousDialogue
            ? store.validContext
            : [
                ...store.validContext,
                {
                  role: "user",
                  content: inputValue
                }
              ]
        )
      } catch (error: any) {
        setStore("loading", false)
        controller = undefined
        if (!error.message.includes("abort")) {
          setStore("messageList", k => [
            ...k,
            {
              role: "error",
              content: error.message.replace(/(sk-\w{5})\w+/g, "$1")
            }
          ])
        }
      }
    }
    archiveCurrentMessage()
  }

  async function fetchGPT(messages: ChatMessage[]) {
    const response = await fetch("/api", {
      method: "POST",
      body: JSON.stringify({
        messages,
        key: store.globalSettings.APIKey || undefined,
        temperature: store.sessionSettings.APITemperature,
        password: store.globalSettings.password,
        model: store.sessionSettings.APIModel
      }),
      signal: controller?.signal
    })
    if (!response.ok) {
      const res = await response.json()
      throw new Error(res.error.message)
    }
    const data = response.body
    if (!data) {
      throw new Error("没有返回数据")
    }
    const reader = data.getReader()
    const decoder = new TextDecoder("utf-8")
    let done = false

    while (!done) {
      const { value, done: readerDone } = await reader.read()
      if (value) {
        const char = decoder.decode(value)
        if (char === "\n" && store.currentAssistantMessage.endsWith("\n")) {
          continue
        }
        if (char) {
          setStore("currentAssistantMessage", k => k + char)
        }
      }
      done = readerDone
    }
  }

  return (
    <main ref={containerRef!} class="mt-4">
      <MessageContainer
        sendMessage={sendMessage}
        inputBoxHeight={inputBoxHeight}
      />
      <InputBox
        height={inputBoxHeight}
        width={containerWidth}
        setHeight={setInputBoxHeight}
        sendMessage={sendMessage}
        stopStreamFetch={stopStreamFetch}
      />
    </main>
  )
}
