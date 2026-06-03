package auth

import (
	"fmt"

	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	UserID         string
	OrgID          string
	Role           string
	JTI            string
	PrincipalClass string // "owner" or "viewer"
}

// ValidateJWT validates an RS256-signed JWT and extracts claims.
func ValidateJWT(tokenStr string, jwks *JWKSCache) (*Claims, error) {
	tok, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		kid, _ := t.Header["kid"].(string)
		return jwks.GetKey(kid)
	}, jwt.WithValidMethods([]string{"RS256"}))
	if err != nil {
		return nil, err
	}

	mc, ok := tok.Claims.(jwt.MapClaims)
	if !ok || !tok.Valid {
		return nil, fmt.Errorf("invalid token claims")
	}

	sub, _ := mc["sub"].(string)
	orgID, _ := mc["org_id"].(string)
	role, _ := mc["role"].(string)
	jti, _ := mc["jti"].(string)

	if sub == "" || orgID == "" {
		return nil, fmt.Errorf("missing required claims")
	}

	return &Claims{
		UserID:         sub,
		OrgID:          orgID,
		Role:           role,
		JTI:            jti,
		PrincipalClass: principalClass(role),
	}, nil
}

func principalClass(role string) string {
	switch role {
	case "owner", "admin":
		return "owner"
	default:
		return "viewer"
	}
}
