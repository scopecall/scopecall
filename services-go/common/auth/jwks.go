package auth

import (
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"sync"
	"time"
)

type jwk struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	N   string `json:"n"`
	E   string `json:"e"`
}

type jwksResponse struct {
	Keys []jwk `json:"keys"`
}

// JWKSCache caches RSA public keys fetched from the JWKS endpoint.
// Re-fetches at most once per minute on key ID miss to handle key rotation.
type JWKSCache struct {
	url      string
	mu       sync.RWMutex
	keys     map[string]*rsa.PublicKey
	lastFetch time.Time
}

func NewJWKSCache(url string) *JWKSCache {
	return &JWKSCache{url: url, keys: make(map[string]*rsa.PublicKey)}
}

func (c *JWKSCache) GetKey(kid string) (*rsa.PublicKey, error) {
	c.mu.RLock()
	k, ok := c.keys[kid]
	c.mu.RUnlock()
	if ok {
		return k, nil
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// double-check under write lock
	if k, ok := c.keys[kid]; ok {
		return k, nil
	}

	// rate-limit re-fetch to once per minute
	if time.Since(c.lastFetch) < time.Minute {
		return nil, fmt.Errorf("unknown key id %q (re-fetch rate limited)", kid)
	}

	if err := c.fetch(); err != nil {
		return nil, err
	}

	k, ok = c.keys[kid]
	if !ok {
		return nil, fmt.Errorf("key id %q not found in JWKS", kid)
	}
	return k, nil
}

func (c *JWKSCache) fetch() error {
	resp, err := http.Get(c.url) //nolint:noctx
	if err != nil {
		return fmt.Errorf("jwks fetch: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck

	var jwks jwksResponse
	if err := json.NewDecoder(resp.Body).Decode(&jwks); err != nil {
		return fmt.Errorf("jwks decode: %w", err)
	}

	next := make(map[string]*rsa.PublicKey, len(jwks.Keys))
	for _, k := range jwks.Keys {
		if k.Kty != "RSA" {
			continue
		}
		pub, err := rsaFromJWK(k)
		if err != nil {
			continue
		}
		next[k.Kid] = pub
	}

	c.keys = next
	c.lastFetch = time.Now()
	return nil
}

func rsaFromJWK(k jwk) (*rsa.PublicKey, error) {
	nb, err := base64.RawURLEncoding.DecodeString(k.N)
	if err != nil {
		return nil, err
	}
	eb, err := base64.RawURLEncoding.DecodeString(k.E)
	if err != nil {
		return nil, err
	}
	e := int(new(big.Int).SetBytes(eb).Int64())
	return &rsa.PublicKey{N: new(big.Int).SetBytes(nb), E: e}, nil
}
