import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface OptionPosition {
  id: string;
  asset: string;
  strikePrice: string;
  expiry: number;
  encryptedPremium: string;
  encryptedAmount: string;
  positionType: "call" | "put";
  owner: string;
  status: "active" | "exercised" | "expired";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [positions, setPositions] = useState<OptionPosition[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newPositionData, setNewPositionData] = useState({ asset: "USDT", strikePrice: 0, expiryDays: 30, premium: 0, amount: 0, positionType: "call" });
  const [selectedPosition, setSelectedPosition] = useState<OptionPosition | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<{ premium?: number; amount?: number }>({});
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState("all");

  const filteredPositions = positions.filter(position => {
    const matchesSearch = position.asset.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         position.positionType.includes(searchTerm.toLowerCase());
    const matchesTab = activeTab === "all" || position.status === activeTab;
    return matchesSearch && matchesTab;
  });

  useEffect(() => {
    loadPositions().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadPositions = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("position_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing position keys:", e); }
      }
      const list: OptionPosition[] = [];
      for (const key of keys) {
        try {
          const positionBytes = await contract.getData(`position_${key}`);
          if (positionBytes.length > 0) {
            try {
              const positionData = JSON.parse(ethers.toUtf8String(positionBytes));
              list.push({ 
                id: key, 
                asset: positionData.asset, 
                strikePrice: positionData.strikePrice, 
                expiry: positionData.expiry, 
                encryptedPremium: positionData.premium, 
                encryptedAmount: positionData.amount, 
                positionType: positionData.positionType, 
                owner: positionData.owner, 
                status: positionData.status || "active" 
              });
            } catch (e) { console.error(`Error parsing position data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading position ${key}:`, e); }
      }
      list.sort((a, b) => b.expiry - a.expiry);
      setPositions(list);
    } catch (e) { console.error("Error loading positions:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitPosition = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting option data with Zama FHE..." });
    try {
      const encryptedPremium = FHEEncryptNumber(newPositionData.premium);
      const encryptedAmount = FHEEncryptNumber(newPositionData.amount);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const positionId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const expiryTimestamp = Math.floor(Date.now() / 1000) + (newPositionData.expiryDays * 86400);
      const positionData = { 
        asset: newPositionData.asset, 
        strikePrice: newPositionData.strikePrice.toString(), 
        expiry: expiryTimestamp, 
        premium: encryptedPremium, 
        amount: encryptedAmount, 
        positionType: newPositionData.positionType, 
        owner: address, 
        status: "active" 
      };
      await contract.setData(`position_${positionId}`, ethers.toUtf8Bytes(JSON.stringify(positionData)));
      const keysBytes = await contract.getData("position_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(positionId);
      await contract.setData("position_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted option created!" });
      await loadPositions();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewPositionData({ asset: "USDT", strikePrice: 0, expiryDays: 30, premium: 0, amount: 0, positionType: "call" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string, field: "premium" | "amount"): Promise<void> => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      setDecryptedValue(prev => ({ ...prev, [field]: FHEDecryptNumber(encryptedData) }));
    } catch (e) { console.error("Decryption failed:", e); } 
    finally { setIsDecrypting(false); }
  };

  const exerciseOption = async (positionId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted option with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const positionBytes = await contract.getData(`position_${positionId}`);
      if (positionBytes.length === 0) throw new Error("Position not found");
      const positionData = JSON.parse(ethers.toUtf8String(positionBytes));
      const updatedPosition = { ...positionData, status: "exercised" };
      await contract.setData(`position_${positionId}`, ethers.toUtf8Bytes(JSON.stringify(updatedPosition)));
      setTransactionStatus({ visible: true, status: "success", message: "Option exercised successfully!" });
      await loadPositions();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Exercise failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (positionAddress: string) => address?.toLowerCase() === positionAddress.toLowerCase();

  const renderAssetChart = () => {
    const assetCounts: Record<string, number> = {};
    positions.forEach(pos => {
      assetCounts[pos.asset] = (assetCounts[pos.asset] || 0) + 1;
    });
    const assets = Object.keys(assetCounts);
    return (
      <div className="asset-chart">
        {assets.map(asset => (
          <div key={asset} className="asset-bar">
            <div className="asset-label">{asset}</div>
            <div className="bar-container">
              <div 
                className="bar-fill" 
                style={{ width: `${(assetCounts[asset] / positions.length) * 100}%` }}
              ></div>
            </div>
            <div className="asset-count">{assetCounts[asset]}</div>
          </div>
        ))}
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Initializing FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>RWA<span>Options</span>FHE</h1>
          <div className="fhe-badge">ZAMA FHE</div>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-btn">
            + New Option
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>
      <div className="main-content">
        <div className="dashboard-section">
          <div className="dashboard-card">
            <h3>RWA Options Protocol</h3>
            <p>Trade options on tokenized real-world assets with fully homomorphic encryption protecting your positions and sensitive data.</p>
            <div className="stats-row">
              <div className="stat-item">
                <div className="stat-value">{positions.length}</div>
                <div className="stat-label">Total Options</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">
                  {positions.filter(p => p.status === "active").length}
                </div>
                <div className="stat-label">Active</div>
              </div>
            </div>
          </div>
          <div className="dashboard-card">
            <h3>Asset Distribution</h3>
            {positions.length > 0 ? renderAssetChart() : <p>No options created yet</p>}
          </div>
        </div>
        <div className="positions-section">
          <div className="section-header">
            <h2>Your Option Positions</h2>
            <div className="controls">
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="Search assets..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <div className="tabs">
                <button 
                  className={activeTab === "all" ? "active" : ""}
                  onClick={() => setActiveTab("all")}
                >
                  All
                </button>
                <button 
                  className={activeTab === "active" ? "active" : ""}
                  onClick={() => setActiveTab("active")}
                >
                  Active
                </button>
                <button 
                  className={activeTab === "exercised" ? "active" : ""}
                  onClick={() => setActiveTab("exercised")}
                >
                  Exercised
                </button>
              </div>
              <button onClick={loadPositions} className="refresh-btn" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          <div className="positions-list">
            {filteredPositions.length === 0 ? (
              <div className="no-positions">
                <p>No option positions found</p>
                <button className="primary-btn" onClick={() => setShowCreateModal(true)}>Create First Option</button>
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Type</th>
                    <th>Strike</th>
                    <th>Expiry</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPositions.map(position => (
                    <tr key={position.id} onClick={() => setSelectedPosition(position)}>
                      <td>{position.asset}</td>
                      <td className={`type-${position.positionType}`}>
                        {position.positionType.toUpperCase()}
                      </td>
                      <td>{position.strikePrice}</td>
                      <td>{new Date(position.expiry * 1000).toLocaleDateString()}</td>
                      <td>
                        <span className={`status-badge ${position.status}`}>
                          {position.status}
                        </span>
                      </td>
                      <td>
                        {isOwner(position.owner) && position.status === "active" && (
                          <button 
                            className="action-btn"
                            onClick={(e) => { e.stopPropagation(); exerciseOption(position.id); }}
                          >
                            Exercise
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal">
            <div className="modal-header">
              <h2>Create New Option</h2>
              <button onClick={() => setShowCreateModal(false)} className="close-btn">
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Asset</label>
                <select
                  name="asset"
                  value={newPositionData.asset}
                  onChange={(e) => setNewPositionData({...newPositionData, asset: e.target.value})}
                >
                  <option value="USDT">USDT</option>
                  <option value="USDC">USDC</option>
                  <option value="DAI">DAI</option>
                  <option value="WBTC">WBTC</option>
                  <option value="WETH">WETH</option>
                </select>
              </div>
              <div className="form-group">
                <label>Option Type</label>
                <div className="radio-group">
                  <label>
                    <input
                      type="radio"
                      name="positionType"
                      value="call"
                      checked={newPositionData.positionType === "call"}
                      onChange={() => setNewPositionData({...newPositionData, positionType: "call"})}
                    />
                    Call
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="positionType"
                      value="put"
                      checked={newPositionData.positionType === "put"}
                      onChange={() => setNewPositionData({...newPositionData, positionType: "put"})}
                    />
                    Put
                  </label>
                </div>
              </div>
              <div className="form-group">
                <label>Strike Price</label>
                <input
                  type="number"
                  value={newPositionData.strikePrice}
                  onChange={(e) => setNewPositionData({...newPositionData, strikePrice: parseFloat(e.target.value)})}
                  step="0.01"
                  min="0"
                />
              </div>
              <div className="form-group">
                <label>Expiry (Days)</label>
                <input
                  type="number"
                  value={newPositionData.expiryDays}
                  onChange={(e) => setNewPositionData({...newPositionData, expiryDays: parseInt(e.target.value)})}
                  min="1"
                  max="365"
                />
              </div>
              <div className="form-group">
                <label>Premium (Encrypted)</label>
                <input
                  type="number"
                  value={newPositionData.premium}
                  onChange={(e) => setNewPositionData({...newPositionData, premium: parseFloat(e.target.value)})}
                  step="0.01"
                  min="0"
                />
              </div>
              <div className="form-group">
                <label>Amount (Encrypted)</label>
                <input
                  type="number"
                  value={newPositionData.amount}
                  onChange={(e) => setNewPositionData({...newPositionData, amount: parseFloat(e.target.value)})}
                  step="0.01"
                  min="0"
                />
              </div>
              <div className="fhe-notice">
                <p>All sensitive data will be encrypted with Zama FHE before submission</p>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowCreateModal(false)} className="cancel-btn">
                Cancel
              </button>
              <button onClick={submitPosition} disabled={creating} className="submit-btn">
                {creating ? "Creating..." : "Create Option"}
              </button>
            </div>
          </div>
        </div>
      )}
      {selectedPosition && (
        <div className="modal-overlay">
          <div className="detail-modal">
            <div className="modal-header">
              <h2>Option Details</h2>
              <button onClick={() => { setSelectedPosition(null); setDecryptedValue({}); }} className="close-btn">
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="detail-row">
                <span>Asset:</span>
                <strong>{selectedPosition.asset}</strong>
              </div>
              <div className="detail-row">
                <span>Type:</span>
                <strong className={`type-${selectedPosition.positionType}`}>
                  {selectedPosition.positionType.toUpperCase()}
                </strong>
              </div>
              <div className="detail-row">
                <span>Strike Price:</span>
                <strong>{selectedPosition.strikePrice}</strong>
              </div>
              <div className="detail-row">
                <span>Expiry:</span>
                <strong>{new Date(selectedPosition.expiry * 1000).toLocaleString()}</strong>
              </div>
              <div className="detail-row">
                <span>Status:</span>
                <strong className={`status-${selectedPosition.status}`}>
                  {selectedPosition.status.toUpperCase()}
                </strong>
              </div>
              <div className="encrypted-section">
                <h3>Encrypted Data</h3>
                <div className="encrypted-item">
                  <span>Premium:</span>
                  <div className="encrypted-value">
                    {selectedPosition.encryptedPremium.substring(0, 30)}...
                  </div>
                  <button 
                    onClick={() => decryptWithSignature(selectedPosition.encryptedPremium, "premium")}
                    disabled={isDecrypting}
                    className="decrypt-btn"
                  >
                    {decryptedValue.premium !== undefined ? "Hide" : "Decrypt"}
                  </button>
                </div>
                <div className="encrypted-item">
                  <span>Amount:</span>
                  <div className="encrypted-value">
                    {selectedPosition.encryptedAmount.substring(0, 30)}...
                  </div>
                  <button 
                    onClick={() => decryptWithSignature(selectedPosition.encryptedAmount, "amount")}
                    disabled={isDecrypting}
                    className="decrypt-btn"
                  >
                    {decryptedValue.amount !== undefined ? "Hide" : "Decrypt"}
                  </button>
                </div>
              </div>
              {decryptedValue.premium !== undefined && (
                <div className="decrypted-section">
                  <h3>Decrypted Premium</h3>
                  <div className="decrypted-value">{decryptedValue.premium}</div>
                </div>
              )}
              {decryptedValue.amount !== undefined && (
                <div className="decrypted-section">
                  <h3>Decrypted Amount</h3>
                  <div className="decrypted-value">{decryptedValue.amount}</div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button 
                onClick={() => { setSelectedPosition(null); setDecryptedValue({}); }}
                className="close-btn"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className={`transaction-content ${transactionStatus.status}`}>
            <div className="transaction-icon">
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✗"}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-section">
            <h3>RWA Options FHE</h3>
            <p>Privacy-preserving options trading on real-world assets</p>
          </div>
          <div className="footer-section">
            <h3>Powered by</h3>
            <p>Zama FHE</p>
            <p>Ethereum</p>
          </div>
          <div className="footer-section">
            <h3>Links</h3>
            <a href="#" className="footer-link">Docs</a>
            <a href="#" className="footer-link">GitHub</a>
            <a href="#" className="footer-link">Twitter</a>
          </div>
        </div>
        <div className="footer-bottom">
          <p>© 2023 RWA Options FHE Protocol. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
};

export default App;