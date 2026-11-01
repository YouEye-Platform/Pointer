"use client";
import { usePointerTranslations } from "@/lib/i18n";

import { useState } from 'react';
import { api } from '@/lib/api';

export function ProviderModelControls({name,models,onChanged}:{name:string;models:Array<{id:string}>;onChanged:()=>Promise<void>}) {
  const translateInterface = usePointerTranslations();

  const [model,setModel]=useState(''),[label,setLabel]=useState(''),[context,setContext]=useState('');
  const [custom,setCustom]=useState(''),[customName,setCustomName]=useState('');
  const [prices,setPrices]=useState({input:'',output:'',cacheRead:'',cacheWrite:''});
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
  async function perform(id:string,task:()=>Promise<unknown>,message:string) {
    setBusy(id);setError('');setNotice('');
    try { await task();await onChanged();setNotice(message); }
    catch(reason){setError(translateInterface("The change could not finish."));}
    finally{setBusy('');}
  }
  const providerPath=`/api/connections/providers/${encodeURIComponent(name)}`;
  return <details className="card"><summary>{translateInterface("Model names, context and prices")}</summary>
    <p className="muted">{translateInterface("These settings apply to this provider. Model names shown to apps still come from their Pointer group.")}</p>
    {error&&<p role="alert" className="error">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <label>{translateInterface("Choose a model")}<select value={model} onChange={event=>{setModel(event.target.value);setLabel('');setContext('');setPrices({input:'',output:'',cacheRead:'',cacheWrite:''});}}><option value="">{translateInterface("Choose a model")}</option>{models.map(row=><option key={row.id}>{row.id}</option>)}</select></label>
    <form className="connection-form" onSubmit={event=>{event.preventDefault();void perform('name',()=>api.put(`${providerPath}/model-display-names`,{modelId:model,displayName:label.trim()}),'Display name saved.');}}>
      <label>{translateInterface("Display name")}<input value={label} onChange={event=>setLabel(event.target.value)} required maxLength={160}/></label>
      <div className="connection-model-actions"><button disabled={Boolean(busy)||!model}>{translateInterface("Save display name")}</button><button type="button" disabled={Boolean(busy)||!model} onClick={()=>void perform('name',()=>api.put(`${providerPath}/model-display-names`,{modelId:model,displayName:null}),'Provider display name restored.')}>{translateInterface("Use provider name")}</button></div>
    </form>
    {name!=='openai'&&<form className="connection-form" onSubmit={event=>{event.preventDefault();void perform('context',()=>api.put('/api/connections/model-settings',{provider:name,modelId:model,contextWindow:Number(context)}),'Context window saved.');}}>
      <label>{translateInterface("Model context window (tokens)")}<input type="number" min={1} step={1} required value={context} onChange={event=>setContext(event.target.value)}/></label>
      <p className="muted">{translateInterface("Use the endpoint's supported limit. This does not increase a provider's capacity or an existing conversation's context window.")}</p>
      <div className="connection-model-actions"><button disabled={Boolean(busy)||!model}>{translateInterface("Save context window")}</button><button type="button" disabled={Boolean(busy)||!model} onClick={()=>void perform('context',()=>api.put('/api/connections/model-settings',{provider:name,modelId:model,contextWindow:null}),'Discovered context window restored.')}>{translateInterface("Use discovered limit")}</button></div>
    </form>}
    <form className="connection-form" onSubmit={event=>{event.preventDefault();void perform('prices',()=>api.put(`${providerPath}/model-costs`,{modelId:model,cost:Object.fromEntries(Object.entries(prices).map(([key,value])=>[key,Number(value)]))}),'Price estimate saved.');}}>
      <h3>{translateInterface("API price estimate · USD per million tokens")}</h3><p className="muted">{translateInterface("Enter all four rates from the provider's price list. Subscription billing is separate.")}</p>
      {(Object.keys(prices) as Array<keyof typeof prices>).map(field=><label key={field}>{({input:'Input',output:'Output',cacheRead:'Cache read',cacheWrite:'Cache write'})[field]}<input type="number" min={0} step="any" required value={prices[field]} onChange={event=>setPrices(current=>({...current,[field]:event.target.value}))}/></label>)}
      <div className="connection-model-actions"><button disabled={Boolean(busy)||!model}>{translateInterface("Save price estimate")}</button><button type="button" disabled={Boolean(busy)||!model} onClick={()=>void perform('prices',()=>api.put(`${providerPath}/model-costs`,{modelId:model,cost:null}),'Price override removed.')}>{translateInterface("Use provider prices")}</button></div>
    </form>
    <form className="connection-form" onSubmit={event=>{event.preventDefault();void perform('custom',()=>api.post('/api/connections/custom-models',{provider:name,modelId:custom.trim(),...(customName.trim()?{displayName:customName.trim()}: {})}),'Model added to provider inventory. Add it to a group to make it available to apps.');}}>
      <h3>{translateInterface("Add an endpoint model")}</h3><p className="muted">{translateInterface("Use its exact upstream identifier. Adding a model does not establish availability or provider entitlement.")}</p>
      <label>{translateInterface("Upstream model ID")}<input required maxLength={300} value={custom} onChange={event=>setCustom(event.target.value)}/></label><label>{translateInterface("Display name (optional)")}<input maxLength={160} value={customName} onChange={event=>setCustomName(event.target.value)}/></label>
      <button disabled={Boolean(busy)}>{translateInterface("Add model")}</button>
    </form>
  </details>;
}
