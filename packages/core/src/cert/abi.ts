// Generated from packages/contracts/out/CertificateRegistry.sol/CertificateRegistry.json (forge build).
// Regenerate after changing CertificateRegistry.sol; test/cert.test.ts checks it against the build output.
export const certificateRegistryAbi = [
  {
    "type": "constructor",
    "inputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "certificateCount",
    "inputs": [
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "certificateOf",
    "inputs": [
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "certId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct CertificateRegistry.Certificate",
        "components": [
          {
            "name": "projectId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "specHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "invariantSetHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "propertyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "codeHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "reportHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "issuedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "passedCount",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "totalCount",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "passedBitmap",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "rehearsalTxCount",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "status",
            "type": "uint8",
            "internalType": "enum CertificateRegistry.Status"
          },
          {
            "name": "supersededBy",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "revokeReasonHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "reportURI",
            "type": "string",
            "internalType": "string"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "currentTargetOf",
    "inputs": [
      {
        "name": "projectId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isCertified",
    "inputs": [
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isCertifiedWith",
    "inputs": [
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "invariantSetHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isIssuer",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isLatest",
    "inputs": [
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "issue",
    "inputs": [
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct CertificateRegistry.IssueParams",
        "components": [
          {
            "name": "target",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "projectId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "specHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "invariantSetHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "propertyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "reportHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "passedCount",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "totalCount",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "passedBitmap",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "rehearsalTxCount",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "reportURI",
            "type": "string",
            "internalType": "string"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "certId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "latest",
    "inputs": [
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "certId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "c",
        "type": "tuple",
        "internalType": "struct CertificateRegistry.Certificate",
        "components": [
          {
            "name": "projectId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "specHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "invariantSetHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "propertyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "codeHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "reportHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "issuedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "passedCount",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "totalCount",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "passedBitmap",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "rehearsalTxCount",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "status",
            "type": "uint8",
            "internalType": "enum CertificateRegistry.Status"
          },
          {
            "name": "supersededBy",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "revokeReasonHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "reportURI",
            "type": "string",
            "internalType": "string"
          }
        ]
      },
      {
        "name": "codeMatches",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "revoke",
    "inputs": [
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "certId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "reasonHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "evidenceURI",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setIssuer",
    "inputs": [
      {
        "name": "issuer",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "allowed",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "CertificateIssued",
    "inputs": [
      {
        "name": "target",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "projectId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "certId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "invariantSetHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "propertyHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "codeHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "reportHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "passedCount",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      },
      {
        "name": "totalCount",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CertificateRevoked",
    "inputs": [
      {
        "name": "target",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "certId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "reasonHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "evidenceURI",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CertificateSuperseded",
    "inputs": [
      {
        "name": "oldTarget",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newTarget",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "projectId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "IssuerSet",
    "inputs": [
      {
        "name": "issuer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "allowed",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "EmptyEvidence",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidCounts",
    "inputs": [
      {
        "name": "passedCount",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "totalCount",
        "type": "uint16",
        "internalType": "uint16"
      }
    ]
  },
  {
    "type": "error",
    "name": "NoCertificate",
    "inputs": [
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotIssuer",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotOwner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotRevocable",
    "inputs": [
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "certId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "status",
        "type": "uint8",
        "internalType": "enum CertificateRegistry.Status"
      }
    ]
  },
  {
    "type": "error",
    "name": "PartialCannotSupersede",
    "inputs": [
      {
        "name": "currentTarget",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "currentCertId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "TargetHasNoCode",
    "inputs": [
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "UnknownCertificate",
    "inputs": [
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "certId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;
